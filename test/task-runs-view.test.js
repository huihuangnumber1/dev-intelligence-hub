import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import {
  createTaskRunsController,
  renderTaskRunDetail,
  renderTaskRuns,
} from "../public/task-runs-view.js";

function run(overrides = {}) {
  return {
    kind: "work-item", taskId: "work/one", runId: "run-one", revision: 1,
    roleId: "developer", title: "Implement controls", subject: "Example/repo#12",
    startedAt: "2026-10-13T00:00:00.000Z", phase: "running", priority: "normal",
    instructions: [], appliedRevision: 1, pendingCommand: null, mode: "active", active: true,
    ...overrides,
  };
}

const response = (value, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  async json() { return structuredClone(value); },
});

const browserExecutable = process.env.MYDASHBOARD_VALIDATION_BROWSER || chromium.executablePath();

test('model queue and recovered receipts have distinct counts and readable states', async () => {
  const queued=run({taskId:'queued-model',phase:'waiting_model'});
  const preparing=run({taskId:'preparing-model',phase:'starting_model'});
  const unknown=run({taskId:'unknown-run',phase:'unknown',active:false,readOnly:true,receipt:{modelStartedAt:null,finishedAt:null,stopConfirmed:false}});
  const body={enabled:true,items:[queued,preparing,run()],held:[],recent:[unknown]};
  const markup=renderTaskRuns({loaded:true,...body});
  assert.match(markup,/正在运行 · 1/);
  assert.match(markup,/等待模型 · 1/);
  assert.match(markup,/准备启动 · 1/);
  assert.match(markup,/最近执行 · 1/);
  assert.match(markup,/等待模型资源，尚未启动/);
  assert.match(markup,/恢复后状态未知/);
  const controller=createTaskRunsController({fetchImpl:async()=>response(body)});
  await controller.refresh();
  assert.equal(controller.getState().recent.length,1);
  assert.match(renderTaskRunDetail({detail:unknown}),/无对话正文/);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("current tasks separate actual model runs from paused tasks and escape content", () => {
  const markup = renderTaskRuns({ loaded: true, enabled: true,
    items: [run({ title: '<script>alert("x")</script>' }), run({ taskId: "queued", active: false })],
    held: [run({ taskId: "held", title: "Paused task", phase: "paused", mode: "paused", active: false })],
  });
  assert.match(markup, /当前运行任务/);
  assert.match(markup, /正在运行 · 1/);
  assert.match(markup, /暂停与待确认 · 1/);
  assert.match(markup, /data-task-run-id="work\/one"/);
  assert.match(markup, /&lt;script&gt;/);
  assert.doesNotMatch(markup, /<script>|data-task-run-id="queued"/);
});

test("background jobs are visible and selectable without claiming an active CLI or offering controls", async () => {
  const background = run({ kind: "code-job", taskId: "job-between-steps", runId: "background:job-between-steps", title: "Repair <feedback>",
    active: false, readOnly: true, phase: "waiting_step", session: null, events: [{ sequence: 1, at: "2026-10-14T06:00:00.000Z", type: "tool", text: "read_text · succeeded · Source/file.cpp" }] });
  const markup = renderTaskRuns({ loaded: true, enabled: true, items: [], held: [], background: [background] });
  assert.match(markup, /后台作业 · 1/);
  assert.match(markup, /data-task-run-id="job-between-steps"/);
  assert.match(markup, /等待下一步骤/);
  assert.match(markup, /Repair &lt;feedback&gt;/);
  const detail = renderTaskRunDetail({ detail: background });
  assert.match(detail, /后台作业.*只读/s);
  assert.doesNotMatch(detail, /检查点兼容模式/);
  assert.match(detail, /data-task-run-command="instruct" disabled/);
  assert.match(detail, /data-task-run-command="priority" disabled/);
  assert.match(detail, /<textarea[^>]*disabled/);
  assert.match(detail, /<select[^>]*disabled/);
  assert.doesNotMatch(detail, /data-task-run-command="pause"|data-task-run-command="cancel"/);
  let posts = 0;
  let listFails = false;
  const controller = createTaskRunsController({ fetchImpl: async (url, options) => {
    if (options.method === "POST") posts += 1;
    if (url === "/api/task-runs" && listFails) return response({ error: "后台作业状态暂时不可用" }, 503);
    return response(url === "/api/task-runs" ? { enabled: true, items: [], held: [], background: [background] } : background);
  } });
  await controller.refresh();
  assert.equal(controller.getState().background.length, 1);
  listFails = true;
  await controller.refresh();
  assert.equal(controller.getState().background.length, 1);
  assert.match(renderTaskRuns(controller.getState()), /上次读取结果/);
  await controller.open(background.kind, background.taskId);
  for (const command of ["instruct", "priority", "pause", "resume", "cancel"]) assert.equal(await controller.control(command), false);
  assert.equal(posts, 0);
});

test("detail distinguishes checkpoint control, confirmed pause, and live submission receipts", () => {
  const detail = (value) => renderTaskRunDetail({ detail: run(value), draft: { instruction: "<unsent>", priority: "high" } });
  const waiting = detail({ phase: "waiting_checkpoint", pendingCommand: "pause" });
  assert.match(waiting, /暂停请求已提交，等待检查点/);
  assert.doesNotMatch(waiting, /data-task-run-command="resume"/);
  assert.match(waiting, /&lt;unsent&gt;/);
  assert.match(waiting, /补充要求不能扩大原任务权限/);
  assert.match(detail({ active: false, mode: "paused", phase: "paused" }), /data-task-run-command="resume"/);
  assert.match(detail({ phase: "control_failed", active: false, pendingCommand: "pause" }), /停止尚未确认/);
  assert.match(detail({ live: true, instructionReceipt: "submitted", revision: 2 }), /实时引导已提交/);
  assert.match(detail({ phase: "waiting_checkpoint", revision: 2 }), /检查点兼容模式/);
  assert.match(detail({ instructionReceipt: "failed", live: true }), /补充要求已保存.*检查点续接/);
  assert.doesNotMatch(detail({ active: false, mode: "active", phase: "idle" }), /data-task-run-command="resume"/);
});

test('CLI session detail exposes current binding and escaped readable events',()=>{
  const markup=renderTaskRunDetail({detail:run({live:true,session:{transport:'app-server',threadId:'thread-1',turnId:'turn-2',status:'running'},events:[
    {sequence:1,at:'2026-10-13T00:00:01.000Z',type:'message',text:'Reading <source>\nChecking errors',itemId:'message-1'},
    {sequence:2,at:'2026-10-13T00:00:02.000Z',type:'tool',text:'Read Source/example.cpp',itemId:'tool-1'},
  ]})});
  assert.match(markup,/CLI 会话/);
  assert.match(markup,/app-server/);
  assert.match(markup,/thread-1/);
  assert.match(markup,/turn-2/);
  assert.match(markup,/Reading &lt;source&gt;\nChecking errors/);
  assert.match(markup,/Read Source\/example.cpp/);
  assert.match(markup,/data-task-run-events/);
  assert.doesNotMatch(markup,/<source>|执行命令|打开终端/);
  const fallback=renderTaskRunDetail({detail:run()});
  assert.match(fallback,/检查点兼容模式/);
  assert.match(fallback,/当前步骤未连接实时 CLI 会话/);
});

test("commands bind current run/revision, suppress duplicate POST, and keep later typing", async () => {
  const pending = deferred();
  const posts = [];
  const controller = createTaskRunsController({
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") { posts.push(options); return pending.promise; }
      return response(run());
    },
  });
  await controller.open("work-item", "work/one");
  controller.setDraft({ instruction: "First instruction" });
  const submitting = controller.control("instruct");
  await controller.control("pause");
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body), {
    runId: "run-one", expectedRevision: 1, command: "instruct", instruction: "First instruction",
  });
  assert.equal(posts[0].headers["x-mydashboard-action"], "1");
  controller.setDraft({ instruction: "Next instruction" });
  pending.resolve(response(run({ revision: 2, phase: "waiting_checkpoint" })));
  await submitting;
  assert.equal(controller.getState().draft.instruction, "Next instruction");
  assert.equal(controller.getState().detail.revision, 2);
  assert.equal(controller.getState().submitting, false);
});

test("a stale command refreshes controls without replaying it or losing unsent input", async () => {
  let current = run();
  let posts = 0;
  const calls = [];
  const controller = createTaskRunsController({ fetchImpl: async (url, options) => {
    calls.push(url);
    if (options.method === "POST") {
      posts += 1;
      current = run({ runId: "run-two", revision: 5, priority: "urgent" });
      return response({ error: "任务运行或修订号已变化" }, 409);
    }
    return response(current);
  } });
  await controller.open("work-item", "work/one");
  controller.setDraft({ instruction: "Keep this draft", priority: "high" });
  await controller.control("instruct");
  const state = controller.getState();
  assert.equal(posts, 1);
  assert.deepEqual(calls, ["/api/task-runs/work-item/work%2Fone", "/api/task-runs/work-item/work%2Fone/control", "/api/task-runs/work-item/work%2Fone"]);
  assert.equal(state.detail.runId, "run-two");
  assert.deepEqual(state.draft, { instruction: "Keep this draft", priority: "high" });
  assert.match(state.detailError, /已更新.*重新提交/);
  await controller.control("priority");
  assert.equal(posts, 2);
});

test("poll responses cannot overwrite a newer control response", async () => {
  const stale = deferred();
  let reads = 0;
  const controller = createTaskRunsController({ fetchImpl: async (_url, options) => {
    if (options.method === "POST") return response(run({ revision: 3, priority: "urgent" }));
    reads += 1;
    return reads === 2 ? stale.promise : response(run());
  } });
  await controller.open("work-item", "work/one");
  const refreshing = controller.refreshDetail();
  controller.setDraft({ priority: "urgent" });
  await controller.control("priority");
  stale.resolve(response(run({ revision: 1 })));
  await refreshing;
  assert.equal(controller.getState().detail.revision, 3);
});

test("failed live steering keeps the draft and explains saved checkpoint fallback", async () => {
  let current = run({ live: true });
  const controller = createTaskRunsController({ fetchImpl: async (_url, options) => {
    if (options.method === "POST") {
      current = run({ live: true, revision: 2, instructionReceipt: "failed", instructions: [{ text: "Saved requirement", at: current.startedAt }] });
      return response({ error: "追加要求未确认送达；已保存，将在安全检查点续接" }, 409);
    }
    return response(current);
  } });
  await controller.open("work-item", "work/one");
  controller.setDraft({ instruction: "Saved requirement" });
  await controller.control("instruct");
  assert.equal(controller.getState().draft.instruction, "Saved requirement");
  assert.match(controller.getState().detailError, /已保存的要求将在检查点续接/);
  assert.doesNotMatch(controller.getState().detailError, /重新提交/);
});

test("visible polling owns one timer and list failures remain local", async () => {
  let visible = true;
  let reads = 0;
  let timerId = 0;
  const timers = new Map();
  const controller = createTaskRunsController({
    isVisible: () => visible,
    setTimeoutImpl(callback, delay) { assert.equal(delay, 5_000); timers.set(++timerId, callback); return timerId; },
    clearTimeoutImpl(id) { timers.delete(id); },
    fetchImpl: async () => { reads += 1; return reads === 1 ? response({ enabled: true, items: [run()], held: [] }) : response({ error: "offline" }, 503); },
  });
  await controller.start();
  await controller.start();
  assert.equal(timers.size, 1);
  visible = false;
  await controller.visibilityChanged();
  assert.equal(timers.size, 0);
  const before = reads;
  await controller.visibilityChanged();
  assert.equal(reads, before);
  visible = true;
  await controller.visibilityChanged();
  assert.equal(timers.size, 1);
  const state = controller.getState();
  assert.equal(state.items.length, 1);
  assert.match(state.error, /offline/);
  assert.match(renderTaskRuns(state), /上次读取结果/);
  controller.stop();
  assert.equal(timers.size, 0);
});

test("task control flow keeps the same task through instruction, priority, pause, resume and cancel", async () => {
  let current = run();
  const commands = [];
  const controller = createTaskRunsController({ fetchImpl: async (url, options) => {
    if (url === "/api/task-runs") return response({ enabled: true,
      items: current.active ? [current] : [], held: current.phase === "paused" ? [current] : [],
    });
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      assert.equal(body.runId, current.runId);
      assert.equal(body.expectedRevision, current.revision);
      commands.push(body.command);
      current = { ...current, revision: current.revision + 1 };
      if (body.command === "instruct") current.instructions.push({ text: body.instruction, at: current.startedAt });
      if (body.command === "priority") current.priority = body.priority;
      if (body.command === "pause") current = { ...current, active: false, phase: "paused", mode: "paused" };
      if (body.command === "resume") current = { ...current, phase: "idle", mode: "active" };
      if (body.command === "cancel") current = { ...current, active: false, phase: "cancelled", mode: "cancelled" };
    }
    return response(current);
  } });
  await controller.refresh();
  await controller.open("work-item", "work/one");
  controller.setDraft({ instruction: "Preserve the original scope" });
  await controller.control("instruct");
  assert.equal(controller.getState().draft.instruction, "");
  controller.setDraft({ priority: "high" });
  await controller.control("priority");
  await controller.control("pause");
  await controller.refresh();
  assert.equal(controller.getState().held.length, 1);
  await controller.control("resume");
  assert.equal(controller.getState().detail.taskId, "work/one");
  assert.match(controller.getState().notice, /等待后续调度/);
  current = { ...current, active: true, phase: "running", runId: "run-two" };
  await controller.refreshDetail();
  await controller.control("cancel");
  assert.equal(controller.getState().detail.phase, "cancelled");
  assert.deepEqual(commands, ["instruct", "priority", "pause", "resume", "cancel"]);
});

test("global task section and dedicated native dialog are wired independently of the active page", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.ok(html.indexOf('id="task-runs"') < html.indexOf('id="content"'));
  assert.match(html, /<dialog id="task-run-dialog"/);
  assert.match(app, /createTaskRunsView\(/);
  assert.match(app, /taskRunsView\.start\(\)/);
  assert.match(app, /embedded: true/);
  assert.match(html, /data-view="workbench"/);
});

test('workbench remembers selection, pins and independent drafts across reload without selecting another task', async () => {
  let saved = null;
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const first = run();
  const second = run({taskId: 'work/two', title: 'Other task'});
  const fetchImpl = async url => response(url === '/api/task-runs' ? { enabled: true, items: [second], held: [] } : url.includes('two') ? second : first);
  const controller = createTaskRunsController({ storage, fetchImpl });
  await controller.open(first.kind, first.taskId);
  controller.setDraft({ instruction: 'Keep this private draft', priority: 'high' });
  controller.togglePin();
  const pinnedMarkup = renderTaskRuns({...controller.getState(), items: [first]});
  assert.equal((pinnedMarkup.match(/data-task-run-id="work\/one"/g) || []).length, 1);
  await controller.open(second.kind, second.taskId);
  controller.setDraft({ instruction: 'Independent draft' });
  await controller.open(first.kind, first.taskId);
  await controller.refresh();
  assert.equal(controller.getState().selected.taskId, first.taskId);
  assert.equal(controller.getState().draft.instruction, 'Keep this private draft');
  const restored = createTaskRunsController({ storage, fetchImpl });
  await restored.refresh();
  assert.equal(restored.getState().selected.taskId, first.taskId);
  assert.equal(restored.getState().draft.priority, 'high');
  assert.deepEqual(restored.getState().pinned, ['work-item:work/one']);
  await restored.open(second.kind, second.taskId);
  assert.equal(restored.getState().draft.instruction, 'Independent draft');
  restored.togglePin();
  assert.equal(JSON.parse(saved).version, 1);
});

test('unavailable or invalid browser storage does not disable task controls', async () => {
  for (const storage of [{getItem: () => '{invalid'}, {getItem: () => null, setItem: () => {throw Error('quota');}}]) {
    const controller = createTaskRunsController({ storage, fetchImpl: async () => response(run()) });
    await controller.open('work-item', 'work/one');
    controller.setDraft({ instruction: 'Continue safely' });
    assert.equal(controller.getState().draft.instruction, 'Continue safely');
    assert.equal(await controller.control('instruct'), true);
  }
});

test('pinned task keeps its fresh terminal state when it leaves the active list', async () => {
  let current = run();
  const controller = createTaskRunsController({fetchImpl: async url => response(url === '/api/task-runs' ? {enabled:true,items:[],held:[]} : current)});
  await controller.open(current.kind, current.taskId);
  controller.togglePin();
  current = run({active:false,phase:'completed'});
  await controller.refreshDetail();
  await controller.refresh();
  const markup = renderTaskRuns(controller.getState());
  assert.match(markup,/已置顶 · 1/);
  assert.match(markup,/已完成/);
  assert.doesNotMatch(markup,/status-pill">正在运行/);
});

test('pinned task outside recent history remains selectable after reload without cached authority', async () => {
  let saved;
  const storage = {getItem: () => saved, setItem: (_key, value) => {saved = value;}};
  const first = run({active:false, phase:'completed', title:'Old pinned task'});
  const second = run({taskId:'work/two'});
  const fetchImpl = async url => response(url === '/api/task-runs' ? {enabled:true,items:[],held:[],recent:[]} : url.includes('two') ? second : first);
  const controller = createTaskRunsController({storage,fetchImpl});
  await controller.open(first.kind,first.taskId); controller.togglePin();
  await controller.open(second.kind,second.taskId);
  const restored = createTaskRunsController({storage,fetchImpl});
  await restored.refresh();
  assert.match(renderTaskRuns(restored.getState()),/Old pinned task/);
  assert.equal(restored.getState().remembered[0].readOnly,true);
  assert.equal(restored.getState().remembered[0].active,false);
  await restored.open(first.kind,first.taskId);
  assert.equal(restored.getState().detail.phase,'completed');
});

test('settled paused task saves instructions for resume while unconfirmed stop remains fenced', async () => {
  let current = run({active: false, phase: 'paused', mode: 'paused'});
  let posts = 0;
  const controller = createTaskRunsController({fetchImpl: async (_url, options) => {
    if (options.method === 'POST') { posts++; current = {...current, revision: current.revision + 1}; }
    return response(current);
  }});
  await controller.open('work-item', 'work/one');
  controller.setDraft({instruction: 'Retest after resume'});
  assert.equal(await controller.control('instruct'), true);
  assert.match(controller.getState().notice, /恢复原任务后应用/);
  assert.match(renderTaskRunDetail(controller.getState()), /恢复执行后应用/);
  current = {...current, stopUnconfirmed: true};
  await controller.refreshDetail();
  controller.setDraft({instruction: 'Do not send yet'});
  assert.equal(await controller.control('instruct'), false);
  assert.equal(posts, 1);
});

test("isolated browser task controls preserve input and support keyboard pause/resume", {
  timeout: 30_000, skip: !existsSync(browserExecutable) && "Playwright Chromium is not installed",
}, async () => {
  const assets = new Map(await Promise.all(["task-runs-view.js", "view-format.js", "styles.css"].map(async (file) =>
    [`/${file}`, await readFile(new URL(`../public/${file}`, import.meta.url), "utf8")],
  )));
  const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body>
    <main class="main"><section id="task-runs" class="task-runs" aria-labelledby="task-runs-title"></section></main>
    <dialog id="task-run-dialog" aria-label="当前运行任务详情"><button type="button" data-task-run-close class="dialog-close" aria-label="关闭任务详情">×</button><div data-task-run-content></div></dialog>
    <script type="module">
      import { createTaskRunsView } from '/task-runs-view.js';
      window.current = ${JSON.stringify(run())}; window.posts = [];
      const reply = (value, status = 200) => ({ ok: status === 200, status, async json() { return structuredClone(value); } });
      window.view = createTaskRunsView({ container: document.querySelector('#task-runs'), dialog: document.querySelector('dialog'), async fetchImpl(url, options = {}) {
        if (url === '/api/task-runs') return reply({ enabled: true, items: current.active ? [current] : [], held: current.phase === 'paused' ? [current] : [], background: window.background ? [window.background] : [] });
        if (options.method !== 'POST') return reply(window.background || current);
        const body = JSON.parse(options.body); posts.push(body);
        if (window.blockNext) { window.blockNext = false; await new Promise((resolve) => { window.releasePost = resolve; }); }
        if (window.conflictNext) { window.conflictNext = false; current = { ...current, revision: current.revision + 1 }; return reply({ error: 'changed' }, 409); }
        current = { ...current, revision: current.revision + 1 };
        if (body.command === 'instruct') { current.instructions.push({ text: body.instruction, at: current.startedAt }); current.phase = 'waiting_checkpoint'; }
        if (body.command === 'pause') { current.pendingCommand = 'pause'; current.phase = 'waiting_checkpoint'; }
        if (body.command === 'resume') { current.mode = 'active'; current.phase = 'idle'; }
        if (body.command === 'priority') current.priority = body.priority;
        return reply(current);
      } }); await view.start(); window.ready = true;
    </script></body></html>`;
  const server = http.createServer((request, result) => {
    const body = assets.get(request.url);
    result.setHeader("content-type", request.url?.endsWith(".js") ? "text/javascript" : request.url?.endsWith(".css") ? "text/css" : "text/html");
    result.end(body || fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: browserExecutable });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.ready);
    const task = page.getByRole("button", { name: /Implement controls/ });
    await task.focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(errors, []);
    assert.equal(await page.locator("dialog").evaluate((element) => element.open), true);
    const dialog = page.getByRole("dialog", { name: "当前运行任务详情" });
    await dialog.getByLabel("补充要求", { exact: true }).fill("Keep this draft");
    await page.evaluate(async () => {
      const input = document.querySelector('textarea'); input.setSelectionRange(4, 4);
      current = { ...current, session: { transport: 'app-server', threadId: 'thread-1', turnId: 'turn-1', status: 'running' },
        events: [{ sequence: 1, at: current.startedAt, type: 'message', text: 'Live progress <safe>' }] };
      await view.refreshDetail();
    });
    assert.match(await dialog.locator('[data-task-run-events]').innerText(),/Live progress <safe>/);
    assert.deepEqual(await page.evaluate(() => ({ value: document.querySelector('textarea').value, caret: document.querySelector('textarea').selectionStart, focused: document.activeElement.tagName })),
      { value: "Keep this draft", caret: 4, focused: "TEXTAREA" });
    await page.evaluate(async () => {
      current = { ...current, events: Array.from({length: 30}, (_, index) => ({ sequence: index + 1,
        at: current.startedAt, type: 'message', text: `Progress ${index} ` + 'code '.repeat(30) })) };
      await view.refreshDetail();
      const output = document.querySelector('[data-task-run-events]'); output.scrollTop = 40; output.focus();
      current = { ...current, events: [...current.events, { sequence: 31, at: current.startedAt, type: 'status', text: 'A later event' }] };
      await view.refreshDetail();
    });
    assert.equal(await dialog.locator('[data-task-run-events]').evaluate((output)=>output.scrollTop),40);
    assert.equal(await dialog.locator('[data-task-run-events]').evaluate((output)=>document.activeElement===output),true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    assert.ok(await dialog.locator('[data-task-run-events]').evaluate((output)=>output.clientHeight<=344));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { window.blockNext = true; const button = document.querySelector('[data-task-run-command="instruct"]'); button.click(); button.click(); });
    assert.equal(await page.evaluate(() => posts.length), 1);
    await page.evaluate(() => releasePost());
    await page.waitForFunction(() => !view.getState().submitting);
    assert.equal(await dialog.getByLabel("补充要求", { exact: true }).inputValue(), "");
    await dialog.getByLabel("补充要求", { exact: true }).fill("Preserved after conflict");
    await page.evaluate(() => { window.conflictNext = true; });
    await dialog.getByRole("button", { name: "提交补充要求" }).click();
    await page.waitForFunction(() => !view.getState().submitting);
    assert.equal(await dialog.getByLabel("补充要求", { exact: true }).inputValue(), "Preserved after conflict");
    assert.match(await dialog.locator('[data-task-run-error]').innerText(), /已更新.*重新提交/);
    await dialog.getByRole("button", { name: "暂停任务" }).click();
    await page.waitForFunction(() => !view.getState().submitting);
    assert.match(await dialog.locator('.task-run-phase').innerText(), /暂停请求已提交，等待检查点/);
    assert.equal(await dialog.getByRole("button", { name: "恢复原任务" }).count(), 0);
    await page.evaluate(async () => { current = { ...current, active: false, mode: 'paused', phase: 'paused', pendingCommand: null }; await view.refresh(); await view.refreshDetail(); });
    await dialog.getByRole("button", { name: "恢复原任务" }).click();
    await page.waitForFunction(() => !view.getState().submitting);
    assert.match(await dialog.locator('[data-task-run-notice]').innerText(), /原任务已恢复，等待后续调度/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    await page.evaluate(async () => {
      window.background = { ...current, kind: 'code-job', taskId: 'background-job', runId: 'background:background-job', title: 'Repair between steps',
        active: false, readOnly: true, phase: 'waiting_step', mode: 'active', session: null, live: false,
        events: [{ sequence: 1, type: 'tool', text: 'read_text · succeeded · Source/file.cpp', at: current.startedAt }] };
      current = { ...current, active: false, phase: 'completed' }; await view.refresh();
    });
    assert.match(await page.locator('#task-runs').innerText(), /后台作业 · 1/);
    await page.getByRole('button', { name: /Repair between steps/ }).click();
    assert.equal(await dialog.getByLabel('补充要求', { exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByLabel('后续调度优先级', { exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: '暂停任务' }).count(), 0);
    assert.match(await dialog.locator('[data-task-run-events]').innerText(), /Source\/file.cpp/);
    assert.match(await dialog.locator('.task-run-delivery').innerText(), /后台作业详情只读/);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    await page.evaluate(async () => {
      current = { ...window.background, readOnly: false, active: true, phase: 'running', runId: 'next-live-run', live: true,
        session: { transport: 'app-server', threadId: 'same-thread', turnId: 'next-turn', status: 'running' } };
      window.background = null; await view.refreshDetail();
    });
    assert.equal(await dialog.getByLabel('补充要求', { exact: true }).isDisabled(), false);
    assert.match(await dialog.locator('[data-task-run-session]').innerText(), /same-thread/);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('embedded workbench preserves selection, caret, pins and drafts through polling and page reload', {
  timeout: 30_000, skip: !existsSync(browserExecutable) && 'Playwright Chromium is not installed',
}, async () => {
  const assets = new Map(await Promise.all(['task-runs-view.js', 'view-format.js', 'styles.css'].map(async file =>
    [`/${file}`, await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8')])));
  const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body>
    <main class="main"><section id="task-runs" class="task-runs"></section></main>
    <script type="module">
      import {createTaskRunsView} from '/task-runs-view.js';
      window.tasks = [${JSON.stringify(run({live: true, session: {transport:'app-server',threadId:'thread-one',status:'running'}, events:[{sequence:1,type:'message',at:'2026-11-02T00:00:00Z',text:'Reading source'}]}))}, ${JSON.stringify(run({taskId:'work/two',title:'Second task'}))}];
      window.posts = [];
      window.view = createTaskRunsView({container:document.querySelector('#task-runs'),embedded:true,async fetchImpl(url,options={}) {
        const reply = value => ({ok:true,status:200,async json(){return structuredClone(value);}});
        if(url==='/api/task-runs')return reply({enabled:true,items:tasks,held:[]});
        const task=tasks.find(t=>url.includes(encodeURIComponent(t.taskId)));
        if(options.method==='POST') {const body=JSON.parse(options.body);posts.push(body);task.revision++;task.instructionReceipt='submitted';}
        return reply(task);
      }});await view.start();window.ready=true;
    </script></body></html>`;
  const server = http.createServer((request, result) => {
    result.setHeader('content-type',request.url.endsWith('.js')?'text/javascript':request.url.endsWith('.css')?'text/css':'text/html');
    result.end(assets.get(request.url)||fixture);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:browserExecutable});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready);
    await page.getByRole('button',{name:/Implement controls/}).click();
    await page.getByLabel('补充要求',{exact:true}).fill('Keep draft one');
    await page.evaluate(async()=>{document.querySelector('textarea').setSelectionRange(4,4);tasks[0].events.push({sequence:2,type:'tool',text:'Read next file'});await view.refreshDetail();await view.refresh();});
    assert.equal(await page.getByLabel('补充要求',{exact:true}).inputValue(),'Keep draft one');
    assert.deepEqual(await page.locator('textarea').evaluate(input=>({caret:input.selectionStart,focused:document.activeElement===input})),{caret:4,focused:true});
    await page.getByRole('button',{name:'置顶任务',exact:true}).click();
    await page.getByRole('button',{name:/Second task/}).click();
    await page.getByLabel('补充要求',{exact:true}).fill('Draft two');
    await page.getByRole('button',{name:/Implement controls/}).first().click();
    assert.equal(await page.getByLabel('补充要求',{exact:true}).inputValue(),'Keep draft one');
    await page.reload();await page.waitForFunction(()=>window.ready);
    await page.getByRole('button',{name:'取消置顶',exact:true}).waitFor();
    assert.equal(await page.getByLabel('补充要求',{exact:true}).inputValue(),'Keep draft one');
    await page.getByRole('button',{name:'提交补充要求',exact:true}).click();
    await page.waitForFunction(()=>!view.getState().submitting);
    assert.match(await page.locator('[data-task-run-notice]').innerText(),/回执不代表模型已经采用/);
    await mkdir(new URL('../validation-artifacts/', import.meta.url), {recursive:true});
    for(const width of [1440,1024,390]) {
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
      if (width !== 1024) await page.screenshot({path:new URL(`../validation-artifacts/task-workbench-${width === 1440 ? 'desktop' : 'mobile'}.png`,import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});
    }
    assert.deepEqual(errors,[]);
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
