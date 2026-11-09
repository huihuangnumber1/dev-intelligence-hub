import assert from "node:assert/strict";
import test from "node:test";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { createCodeJobGrant, CODE_JOB_ACTIONS_BY_OPERATION } from "../src/domain/code-job-contract.js";
import { CodeJobStore } from "../src/services/code-job-store.js";
import { TaskRunRegistry } from "../src/services/task-run-registry.js";
import { createTaskRunView } from "../src/services/task-run-view.js";

const NOW = "2026-10-14T06:00:00.000Z";
const JOB_ID = `code-job-${"a".repeat(55)}`;

function memoryStore() {
  const values = new Map();
  return { async read(key, fallback) { return structuredClone(values.get(key) ?? fallback); },
    async write(key, value) { values.set(key, structuredClone(value)); } };
}

function job(overrides = {}) {
  return { jobId: JOB_ID, status: "active", revision: 3, requestedBy: { roleId: "developer" },
    subject: { repository: "Example/repo", number: 17 }, repository: "Example/repo", objective: "Repair review feedback",
    createdAt: NOW, updatedAt: NOW, turn: 2, pendingActionType: null, latestObservation: null, ...overrides };
}

function setup(reader) {
  const registry = new TaskRunRegistry({ store: memoryStore(), clock: () => new Date(NOW), settleControl: async () => {} });
  return { registry, view: createTaskRunView({ registry, codeJobReader: reader }) };
}

function readerFor(jobs) {
  return { async list({ status }) { return { items: jobs.filter((item) => item.status === status), nextCursor: null }; },
    async get(id) { return jobs.find((item) => item.jobId === id) ?? null; },
    async getDetail({ jobId }) { return { job: jobs.find((item) => item.jobId === jobId), observations: [], nextCursor: null }; } };
}

test('recovered unknown native execution remains visible ahead of background waiting state',async()=>{
  const unknown={kind:'code-job',taskId:JOB_ID,phase:'unknown',active:false,mode:'active',pendingCommand:null,receipt:{phase:'unknown',stopConfirmed:false}};
  const registry={async get(){return unknown;},async list(){return {enabled:true,items:[],held:[],recent:[unknown]};}};
  const view=createTaskRunView({registry,codeJobReader:readerFor([job()])});
  assert.equal((await view.get('code-job',JOB_ID)).phase,'unknown');
  const list=await view.list();
  assert.equal(list.background.length,0);
  assert.equal(list.recent.length,1);
});

test("ongoing background jobs remain visible between steps, without counting queued or terminal jobs as running", async () => {
  const { view } = setup(readerFor([job(), job({ jobId: "starting", status: "starting" }), job({ jobId: "queued", status: "queued" }), job({ jobId: "done", status: "completed" })]));
  const result = await view.list();
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.held, []);
  assert.equal(result.enabled, true);
  assert.deepEqual(result.background.map(({ taskId, phase }) => ({ taskId, phase })), [
    { taskId: JOB_ID, phase: "waiting_step" }, { taskId: "starting", phase: "preparing" },
  ]);
  assert.ok(result.background.every((task) => task.active === false && task.session === null && task.readOnly === true));
});

test("active and held registry runs take precedence over background jobs", async () => {
  const { view, registry } = setup(readerFor([job()]));
  let finish;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const execution = registry.run({ kind: "code-job", taskId: JOB_ID, roleId: "developer", title: "Current step", subject: "Example/repo", revision: 3 }, async () => {
    entered(); await new Promise((resolve) => { finish = resolve; });
  });
  await ready;
  try {
    const listed = await view.list();
    assert.equal(listed.items.length, 1);
    assert.deepEqual(listed.background, []);
    assert.deepEqual(await view.get("code-job", JOB_ID), await registry.get("code-job", JOB_ID));
    const active = listed.items[0];
    await registry.control("code-job", JOB_ID, { runId: active.runId, expectedRevision: active.revision, command: "pause" });
  } finally { finish(); await execution.catch(() => {}); }
  assert.equal((await view.list()).held.length, 1);
  assert.deepEqual((await view.list()).background, []);
  assert.equal((await view.get("code-job", JOB_ID)).phase, "paused");
});

test("background detail exposes only the last eight safe action facts, not code or grant material", async () => {
  const original = job({ grant: { secret: "credential-material" }, summary: "hidden output" });
  const observations = Array.from({ length: 25 }, (_, index) => ({ actionType: "read_text", status: "succeeded", recordedAt: NOW,
    detail: { result: { path: `Source/file-${index}.cpp`, text: "private source code", secret: "credential-material" } } }));
  const calls = [];
  const reader = readerFor([original]);
  reader.getDetail = async (input) => {
    calls.push(input);
    const offset = input.cursor ? 20 : 0;
    return { job: original, observations: observations.slice(offset, offset + 20), nextCursor: offset === 0 ? "page-two" : null };
  };
  const { view, registry } = setup(reader);
  const detail = await view.get("code-job", JOB_ID);
  assert.equal(detail.phase, "waiting_step");
  assert.equal(detail.readOnly, true);
  assert.equal(detail.revision, 3);
  assert.equal(detail.session, null);
  assert.equal(detail.events.length, 8);
  assert.match(detail.events[0].text, /Source\/file-17.cpp/);
  assert.match(detail.events.at(-1).text, /Source\/file-24.cpp/);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(detail), /private source code|credential-material|hidden output/);
  assert.deepEqual(Object.keys(view).sort(), ["get", "list"]);
  await assert.rejects(registry.control("code-job", JOB_ID, { runId: detail.runId, expectedRevision: detail.revision, command: "cancel" }));
});

test("reader errors and repeated pagination fail visibly instead of reporting an empty background queue", async () => {
  const reader = readerFor([]);
  reader.list = async () => { throw new Error("private disk path and token"); };
  const { view } = setup(reader);
  await assert.rejects(view.list(), (error) => error.statusCode === 503 && error.code === "TASK_RUN_BACKGROUND_UNAVAILABLE" && !error.message.includes("token"));
  reader.list = async () => ({ items: [job()], nextCursor: "same-cursor" });
  await assert.rejects(view.list(), (error) => error.statusCode === 503);
  reader.getDetail = async () => { throw new Error("cannot read job"); };
  await assert.rejects(view.get("code-job", JOB_ID), (error) => error.statusCode === 503);
});

test("absent readers preserve registry behavior and finished jobs do not reopen as background work", async () => {
  const { view } = setup(null);
  assert.deepEqual(await view.list(), { enabled: true, items: [], held: [], background: [] });
  await assert.rejects(view.get("work-item", "absent"), { code: "TASK_RUN_NOT_FOUND" });
  const finished = setup(readerFor([job({ status: "completed" })]));
  await assert.rejects(finished.view.get("code-job", JOB_ID), { code: "TASK_RUN_NOT_FOUND" });
});

test("real public code-job store and registry show one active job throughout a model-step boundary", async () => {
  const store = memoryStore();
  const jobs = new CodeJobStore({ store, exclusiveLease: { run: (operation) => operation() }, operationQueue: new OperationQueue(), clock: () => new Date(NOW) });
  await jobs.recover();
  const grant = createCodeJobGrant({ schemaVersion: 2, proposalId: "proposal-1", contentDigest: "a".repeat(64), policyVersion: 1,
    requestedBy: { roleId: "developer", workItemId: "work-1" }, source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: { id: "github:pr:Example/repo#17", repository: "Example/repo", number: 17 }, repository: "Example/repo", workspaceId: "example",
    inputBinding: null, workspaceAuthorityDigest: "b".repeat(64), operation: "inspect", objective: "Read review evidence", acceptanceCriteria: ["Evidence checked"],
    evidence: ["Review feedback"], summary: "Inspect", reason: "Review repair", allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION.inspect], writablePaths: [],
    requiredProfiles: [{ id: "tests", configDigest: "c".repeat(64) }], brainDigest: "d".repeat(64) });
  const created = await jobs.createApprovedJob({ confirmationId: "confirmation-1", requestId: "request-1", displayedPayloadDigest: "e".repeat(64), approvalBindingDigest: "f".repeat(64), grant });
  const starting = await jobs.claimStarting({ jobId: created.job.jobId, expectedRevision: created.job.revision });
  await jobs.activate({ jobId: created.job.jobId, expectedRevision: starting.job.revision, workspaceRevision: "1".repeat(64) });
  const { view, registry } = setup(jobs);
  assert.equal((await view.list()).background.length, 1);
  let finish;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const execution = registry.run({ kind: "code-job", taskId: created.job.jobId, roleId: "developer", title: "Inspect", subject: "Example/repo", revision: 3 }, async () => {
    entered(); await new Promise((resolve) => { finish = resolve; });
  });
  await ready;
  try { const active = await view.list(); assert.equal(active.items.length, 1); assert.equal(active.background.length, 0); }
  finally { finish(); await execution; }
  assert.equal((await view.list()).background.length, 1);
  assert.equal((await view.get("code-job", created.job.jobId)).phase, "waiting_step");
});
