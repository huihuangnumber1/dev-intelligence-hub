import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { normalizePullRequestGitTarget } from "../src/domain/git-tool-contract.js";
import { OllamaPrEmployeeReviewer } from "../src/adapters/ollama-pr-employee-reviewer.js";
import { RoutedPrEmployeeReviewer } from "../src/adapters/routed-pr-employee-reviewer.js";
import { ActionAdmissionGate } from "../src/lib/action-admission-gate.js";
import { ProactivePrEmployeeService } from "../src/services/proactive-pr-employee.js";
import { assessPullRequestResponsibility } from "../src/domain/pr-responsibility.js";

const HEAD_42 = "b".repeat(40);
const HEAD_43 = "c".repeat(40);
const HEAD_OLD = "d".repeat(40);

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  async read(name, fallback = null) {
    return this.values.has(name) ? structuredClone(this.values.get(name)) : fallback;
  }

  async write(name, value) {
    this.values.set(name, structuredClone(value));
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class BlockingStateStore extends MemoryStore {
  constructor(entries, blockedWriteNumber) {
    super(entries);
    this.blockedWriteNumber = blockedWriteNumber;
    this.stateWrites = 0;
    this.writeStarted = deferred();
    this.writeRelease = deferred();
  }

  async write(name, value) {
    if (name === "pr-employee-state") {
      this.stateWrites += 1;
      if (this.stateWrites === this.blockedWriteNumber) {
        this.writeStarted.resolve();
        await this.writeRelease.promise;
      }
    }
    return super.write(name, value);
  }
}

class LostStateWriteAcknowledgementStore extends MemoryStore {
  constructor(entries, lostWriteNumber) {
    super(entries);
    this.lostWriteNumber = lostWriteNumber;
    this.stateWrites = 0;
  }

  async write(name, value) {
    await super.write(name, value);
    if (name === "pr-employee-state") {
      this.stateWrites += 1;
      if (this.stateWrites === this.lostWriteNumber) {
        throw new Error("state write acknowledgement lost");
      }
    }
  }
}

class SnapshotChangingOnClaimStore extends MemoryStore {
  constructor(entries, replacementSnapshot) {
    super(entries);
    this.replacementSnapshot = replacementSnapshot;
    this.stateWrites = 0;
  }

  async write(name, value) {
    await super.write(name, value);
    if (name === "pr-employee-state") {
      this.stateWrites += 1;
      if (this.stateWrites === 2) {
        this.values.set("snapshot", structuredClone(this.replacementSnapshot));
      }
    }
  }
}

function readyGate(version = 1) {
  const gate = new ActionAdmissionGate();
  gate.bindEffective({
    version,
    configurationDigest: String(version).repeat(64),
  });
  return gate;
}

function cutoverToVersion(gate, version) {
  return gate.cutover(({ commit }) => {
    commit({
      version,
      configurationDigest: String(version).repeat(64),
    });
  });
}

async function settlesBefore(promise, durationMs = 250) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), durationMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function pullRequest(overrides = {}) {
  const headRefOid = overrides.headRefOid || HEAD_42;
  const item = {
    id: "github:pr:acme/repo#42",
    kind: "pull_request",
    relation: "review_requested",
    repo: "acme/repo",
    number: 42,
    title: "Protect the checkout flow",
    url: "https://github.example/acme/repo/pull/42",
    author: "someone-else",
    state: "open",
    updatedAt: "2026-07-31T09:00:00.000Z",
    reviewFactsAvailable: true,
    headRefOid,
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "a".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/review",
      headRefOid,
    },
    actionState: "action_now",
    nextAction: "review",
    actionReasons: ["等待你首次审核"],
    ...overrides,
  };
  if (
    overrides.gitTargetAvailable === false &&
    !Object.hasOwn(overrides, "gitTarget")
  ) {
    delete item.gitTarget;
  }
  return item;
}

function gitTargetDigest(item) {
  return createHash("sha256")
    .update(JSON.stringify(normalizePullRequestGitTarget(item.gitTarget)), "utf8")
    .digest("hex");
}

function snapshot(items, overrides = {}) {
  return {
    refreshedAt: "2026-07-31T10:00:00.000Z",
    sourceStatus: { githubPullRequests: { ok: true } },
    items,
    ...overrides,
  };
}

function reviewResult(overrides = {}) {
  return {
    workType: "review_draft",
    summary: "支付失败路径缺少回归覆盖，建议先补测试。",
    confidence: 0.86,
    evidence: ["checkout.js 修改了错误分支"],
    steps: ["补充失败路径测试", "核对错误码映射"],
    questions: [],
    reviewVerdict: "request_changes",
    reviewBody: "建议补充失败路径测试后再合并。",
    requiresApproval: true,
    ...overrides,
  };
}

function queuedState(item = pullRequest(), overrides = {}) {
  const policyVersion = overrides.policyVersion ?? 1;
  const createdAt = "2026-07-31T10:00:00.000Z";
  return {
    revision: 3,
    paused: false,
    jobs: [
      {
        id: "pr-work-existing",
        fingerprint: [
          item.id,
          gitTargetDigest(item),
          item.nextAction,
          policyVersion,
        ].join("\u0000"),
        policyVersion,
        subjectId: item.id,
        repo: item.repo,
        number: item.number,
        title: item.title,
        url: item.url,
        relation: item.relation,
        headRefOid: item.headRefOid,
        gitTargetDigest: gitTargetDigest(item),
        nextAction: item.nextAction,
        triggerReason: item.actionReasons[0],
        status: "queued",
        attempts: 0,
        createdAt,
        updatedAt: createdAt,
        ...overrides,
      },
    ],
    memoryOutbox: [],
    memoryOutboxError: "",
    memoryOutboxDropped: 0,
    lastRun: null,
    lastError: "",
  };
}

function createService({
  store,
  github,
  reviewer,
  now,
  config = {},
  triageHandoff,
  actionAdmissionGate,
} = {}) {
  return new ProactivePrEmployeeService({
    store,
    github,
    reviewer,
    clock: () => new Date(now || "2026-07-31T10:01:00.000Z"),
    config: {
      enabled: true,
      name: "PR 推进员工",
      policyVersion: 1,
      maxJobsPerTick: 2,
      maxAttempts: 3,
      retryMinutes: [1, 5, 30],
      memoryLimit: 100,
      ...config,
    },
    triageHandoff,
    actionAdmissionGate,
  });
}

function durableTriageHandoff(onSubmit = () => {}) {
  return {
    async submit(input) {
      onSubmit(input);
      return { workItemId: `work-item-${input.targetRoleId}` };
    },
  };
}

test('repeated remote model capacity survives restart, backs off, and retains the PR business budget', async () => {
  const item = pullRequest();
  const store = new MemoryStore({ snapshot: snapshot([item]) });
  let calls = 0;
  const reviewer = routedTriageReviewer({ primary: async () => {
    calls++;
    throw Object.assign(new Error('Selected model is at capacity. Please try a different model.'), { code: 'STRUCTURED_PROVIDER_MODEL_CAPACITY' });
  } });
  const options = { store, reviewer, config: { triageOnly: true }, triageHandoff: durableTriageHandoff(() => assert.fail('capacity must wait')),
    github: { async loadReviewContext() { return { ...item }; } } };
  let now = '2026-07-31T10:01:00.000Z';
  for (let attempt = 1; attempt <= 5; attempt++) {
    await createService({ ...options, now }).tick();
    const waiting = (await store.read('pr-employee-state')).jobs[0];
    assert.equal(waiting.status, 'retry_wait');
    assert.equal(waiting.attempts - waiting.analysisAttemptBudget.attemptOffset, 0);
    assert.equal(waiting.analysisFailure.infrastructureFailure, true);
    assert.equal(Date.parse(waiting.nextAttemptAt) > Date.parse(now), true);
    await createService({ ...options, now }).tick();
    assert.equal(calls, attempt, 'the scheduler cannot retry before the persisted backoff expires');
    now = waiting.nextAttemptAt;
  }
});

function exhaustedOllamaState(item = pullRequest(), overrides = {}) {
  return queuedState(item, { policyVersion: 3, status: "blocked", attempts: 3,
    error: "Ollama employee transport request failed",
    brain: { provider: "ollama", model: "qwen3.5:9b" }, ...overrides });
}

function routedTriageReviewer({ primary, fallback } = {}) {
  return new RoutedPrEmployeeReviewer({
    primaryBrain: { provider: "codex-login-cli", model: "gpt-5.6-luna", remoteData: { requirements: true, code: true, memory: false } },
    router: { generate: primary || (async () => JSON.stringify(reviewResult({ workType: "triage_plan", reviewVerdict: "none", reviewBody: "", requiresApproval: false }))) },
    fallback: { provider: "ollama", model: "qwen3.5:9b", analyze: fallback || (async () => { throw new Error("Unexpected fallback"); }) },
  });
}

for (const reason of ["PR_EMPLOYEE_PRIMARY_TIMEOUT", "STRUCTURED_PROVIDER_PROCESS_FAILED"]) test(`a current PR blocked by ${reason} and backup transport failure recovers without consuming review budget`, async () => {
  const item = pullRequest();
  const initial = exhaustedOllamaState(item, {
    brain: { provider: "ollama", model: "qwen3.5:9b", fallbackFrom: { provider: "codex-login-cli", model: "gpt-5.6-luna", reason } },
    analysisAttemptBudget: { provider: "codex-login-cli", model: "gpt-5.6-luna", attemptOffset: 0 },
    analysisFailure: { phase: "analysis", code: "PR_EMPLOYEE_JOB_FAILED", modelFailure: true },
  });
  const store = new MemoryStore({ snapshot: snapshot([item]), "pr-employee-state": initial });
  let busy = true, fallbackCalls = 0; const handoffs = [];
  const reviewer = routedTriageReviewer({ primary: async () => {
    if (busy) throw Object.assign(new Error("capacity occupied"), { code: "STRUCTURED_PROVIDER_BUSY" });
    return JSON.stringify(reviewResult({ workType: "triage_plan", reviewVerdict: "none", reviewBody: "", requiresApproval: false }));
  }, fallback: async () => { fallbackCalls++; assert.fail("capacity waiting cannot trigger fallback"); } });
  const options = { store, reviewer, config: { triageOnly: true }, github: { async loadReviewContext() { return { ...item }; } },
    triageHandoff: durableTriageHandoff(request => handoffs.push(request)) };
  await createService(options).tick();
  const waiting = (await store.read("pr-employee-state")).jobs[0];
  assert.equal(waiting.id, initial.jobs[0].id);
  assert.equal(waiting.fingerprint, initial.jobs[0].fingerprint);
  assert.equal(waiting.status, "retry_wait");
  assert.equal(waiting.attempts, 4);
  assert.equal(waiting.analysisAttemptBudget.attemptOffset, 2, "refund only the last proven legacy infrastructure failure and the new busy admission");
  assert.equal(waiting.analysisFailure.infrastructureFailure, true);
  busy = false;
  await createService({ ...options, now: "2026-07-31T10:03:00.000Z" }).tick();
  assert.equal((await store.read("pr-employee-state")).jobs[0].status, "ready");
  assert.equal(handoffs.length, 1);
  assert.equal(fallbackCalls, 0);
  await createService({ ...options, now: "2026-07-31T10:04:00.000Z" }).tick();
  assert.equal(handoffs.length, 1);
});

test("primary model activation recovers one exhausted Ollama job without replacing requests or completed triage", async () => {
  const item = pullRequest();
  const completedItem = pullRequest({ id: "github:pr:acme/repo#43", number: 43, headRefOid: HEAD_43 });
  const initial = exhaustedOllamaState(item);
  const completed = queuedState(completedItem, { policyVersion: 3, id: "pr-work-completed", status: "ready", attempts: 1,
    completedAt: "2026-07-31T09:59:00.000Z", handoffWorkItemId: "work-item-already-delivered" }).jobs[0];
  initial.jobs.push(completed);
  const store = new MemoryStore({ snapshot: snapshot([item, completedItem]), "pr-employee-state": initial });
  let primaryCalls = 0;
  const handoffs = [];
  const reviewer = routedTriageReviewer({ primary: async () => {
    primaryCalls += 1;
    return JSON.stringify(reviewResult({ workType: "triage_plan", reviewVerdict: "none", reviewBody: "", requiresApproval: false }));
  } });
  const options = { store, reviewer, config: { triageOnly: true }, github: { async loadReviewContext() { return { ...item }; } },
    triageHandoff: durableTriageHandoff((request) => handoffs.push(request)) };
  await createService(options).tick();
  const after = await store.read("pr-employee-state");
  assert.equal(after.jobs.length, 2);
  assert.equal(after.jobs[0].id, initial.jobs[0].id);
  assert.equal(after.jobs[0].fingerprint, initial.jobs[0].fingerprint);
  assert.equal(after.jobs[0].status, "ready");
  assert.equal(after.jobs[0].attempts, 4);
  assert.deepEqual(after.jobs[0].analysisAttemptBudget, { provider: "codex-login-cli", model: "gpt-5.6-luna", attemptOffset: 3 });
  assert.deepEqual(after.jobs[1], completed);
  assert.equal(handoffs[0].requestKey, initial.jobs[0].id);
  await createService(options).tick();
  assert.equal(primaryCalls, 1);
  assert.equal(handoffs.length, 1);
  assert.deepEqual((await store.read("pr-employee-state")).jobs, after.jobs);
});

test("primary and backup infrastructure failures retain attribution and back off without exhausting the model budget", async () => {
  const item = pullRequest();
  const store = new MemoryStore({ snapshot: snapshot([item]), "pr-employee-state": exhaustedOllamaState(item) });
  let primaryCalls = 0; let fallbackCalls = 0;
  const reviewer = routedTriageReviewer({
    primary: async () => { primaryCalls += 1; throw Object.assign(new Error("Codex process ended"), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" }); },
    fallback: async () => { fallbackCalls += 1; throw new Error("Ollama employee transport request failed"); },
  });
  const options = { store, reviewer, config: { triageOnly: true }, github: { async loadReviewContext() { return { ...item }; } },
    triageHandoff: durableTriageHandoff(() => assert.fail("failed analysis must not hand off")) };
  for (const now of ["2026-07-31T10:01:00.000Z", "2026-07-31T10:03:00.000Z", "2026-07-31T10:10:00.000Z"]) {
    await createService({ ...options, now }).tick();
  }
  const waiting = (await store.read("pr-employee-state")).jobs[0];
  assert.equal(waiting.status, "retry_wait");
  assert.equal(waiting.attempts, 4);
  assert.equal(waiting.error, "Ollama employee transport request failed");
  assert.deepEqual(waiting.brain, { provider: "ollama", model: "qwen3.5:9b", fallbackFrom: {
    provider: "codex-login-cli", model: "gpt-5.6-luna", reason: "STRUCTURED_PROVIDER_PROCESS_FAILED" } });
  assert.deepEqual(waiting.analysisAttemptBudget, { provider: "codex-login-cli", model: "gpt-5.6-luna", attemptOffset: 4 });
  await createService({ ...options, now: "2026-08-01T10:01:00.000Z" }).tick();
  assert.deepEqual([primaryCalls, fallbackCalls], [2, 2]);
  const retried = (await store.read("pr-employee-state")).jobs[0];
  assert.equal(retried.status, "retry_wait");
  assert.equal(retried.attempts, 5);
  assert.equal(retried.analysisAttemptBudget.attemptOffset, 5);
});

test("a PR waiting for both providers leaves the next PR eligible in the same patrol", async () => {
  const first = pullRequest();
  const second = pullRequest({ id: "github:pr:acme/repo#43", number: 43 });
  const store = new MemoryStore({ snapshot: snapshot([first, second]) });
  const reviewer = routedTriageReviewer({
    primary: async request => {
      if (request.sessionKey.endsWith("#42")) {
        throw Object.assign(new Error("Codex process failed"), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" });
      }
      return JSON.stringify(reviewResult({ workType: "triage_plan", reviewVerdict: "none", reviewBody: "", requiresApproval: false }));
    },
    fallback: async () => {
      throw Object.assign(new Error("Ollama 服务或配置的模型不可用"), { code: "STRUCTURED_PROVIDER_UNAVAILABLE" });
    },
  });
  const service = createService({ store, reviewer, config: { triageOnly: true },
    github: { async loadReviewContext(candidate) { return candidate; } },
    triageHandoff: durableTriageHandoff() });
  await service.tick();
  const state = await store.read("pr-employee-state");
  const waiting = state.jobs.find(job => job.number === 42);
  assert.equal(waiting.status, "retry_wait");
  assert.equal(waiting.analysisFailure.infrastructureFailure, true);
  assert.equal(waiting.analysisAttemptBudget.attemptOffset, 1);
  assert.equal(state.jobs.find(job => job.number === 43).status, "ready");
  const view = await service.roleView();
  assert.match(view.lastError, /主模型 .*STRUCTURED_PROVIDER_PROCESS_FAILED.*备用模型 .*Ollama 服务或配置的模型不可用/);
});

for (const [receiptName, failureReceipt] of [
  ["legacy", {}],
  ["recorded", { analysisAttemptBudget: { provider: "ollama", model: "qwen3.5:9b", attemptOffset: 0 },
    analysisFailure: { phase: "analysis", code: "PR_EMPLOYEE_JOB_FAILED", modelFailure: true } }],
]) {
  test(`a due ${receiptName} known analysis retry binds the new model budget without advancing its existing retry time`, async () => {
    const item = pullRequest();
    const initial = exhaustedOllamaState(item, { status: "retry_wait", attempts: 2, nextAttemptAt: "2026-07-31T10:02:00.000Z", ...failureReceipt });
    const store = new MemoryStore({ snapshot: snapshot([item]), "pr-employee-state": initial });
    let primaryCalls = 0; let fallbackCalls = 0;
    const reviewer = routedTriageReviewer({
      primary: async () => { primaryCalls += 1; throw Object.assign(new Error("Codex ended"), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" }); },
      fallback: async () => { fallbackCalls += 1; throw new Error("Ollama employee transport request failed"); },
    });
    const options = { store, reviewer, config: { triageOnly: true }, github: { async loadReviewContext() { return { ...item }; } },
      triageHandoff: durableTriageHandoff(() => assert.fail("failed retry must not hand off")) };
    await createService({ ...options, now: "2026-07-31T10:01:00.000Z" }).tick();
    assert.deepEqual((await store.read("pr-employee-state")).jobs, initial.jobs);
    assert.equal(primaryCalls, 0);
    await createService({ ...options, now: "2026-07-31T10:03:00.000Z" }).tick();
    const first = (await store.read("pr-employee-state")).jobs[0];
    assert.equal(first.id, initial.jobs[0].id);
    assert.equal(first.fingerprint, initial.jobs[0].fingerprint);
    assert.equal(first.status, "retry_wait");
    assert.equal(first.attempts, 3);
    assert.deepEqual(first.analysisAttemptBudget, { provider: "codex-login-cli", model: "gpt-5.6-luna", attemptOffset: 3 });
    for (const now of ["2026-07-31T10:05:00.000Z", "2026-07-31T10:11:00.000Z", "2026-08-01T10:01:00.000Z"]) {
      await createService({ ...options, now }).tick();
    }
    const blocked = (await store.read("pr-employee-state")).jobs[0];
    assert.equal(blocked.status, "retry_wait");
    assert.equal(blocked.attempts, 4);
    assert.equal(blocked.analysisAttemptBudget.attemptOffset, 4);
    assert.deepEqual([primaryCalls, fallbackCalls], [2, 2]);
  });
}

for (const [name, changes] of [
  ["unknown failure", { error: "unknown failure" }],
  ["context failure", { analysisFailure: { phase: "context", code: "PR_EMPLOYEE_JOB_FAILED", modelFailure: false } }],
  ["handoff failure", { analysisFailure: { phase: "handoff", code: "PR_EMPLOYEE_JOB_FAILED", modelFailure: false } }],
  ["same primary after fallback", { brain: { provider: "ollama", model: "qwen3.5:9b", fallbackFrom: {
    provider: "codex-login-cli", model: "gpt-5.6-luna", reason: "STRUCTURED_PROVIDER_PROCESS_FAILED" } } }],
]) {
  test(`a due ${name} retry retains earlier charges while the new infrastructure failure stays retryable`, async () => {
    const item = pullRequest();
    const initial = exhaustedOllamaState(item, { status: "retry_wait", attempts: 2, nextAttemptAt: "2026-07-31T10:00:00.000Z", ...changes });
    const store = new MemoryStore({ snapshot: snapshot([item]), "pr-employee-state": initial });
    let primaryCalls = 0;
    const reviewer = routedTriageReviewer({ primary: async () => { primaryCalls += 1; throw Object.assign(new Error("Codex ended"), { code: "STRUCTURED_PROVIDER_PROCESS_FAILED" }); },
      fallback: async () => { throw new Error("Ollama employee transport request failed"); } });
    const options = { store, reviewer, config: { triageOnly: true }, github: { async loadReviewContext() { return { ...item }; } },
      triageHandoff: durableTriageHandoff() };
    await createService(options).tick();
    const blocked = (await store.read("pr-employee-state")).jobs[0];
    assert.equal(blocked.status, "retry_wait");
    assert.equal(blocked.attempts, 3);
    assert.equal(blocked.analysisAttemptBudget.attemptOffset, 1);
    await createService({ ...options, now: "2026-08-01T10:01:00.000Z" }).tick();
    assert.equal(primaryCalls, 2);
  });
}

for (const [name, jobChanges, snapshotChanges, stateChanges] of [
  ["unknown failure", { error: "ledger unavailable" }],
  ["confirmation-bearing work", { confirmationId: "confirmation-existing" }],
  ["confirmation intent", { confirmationIntent: { id: "confirmation-existing" } }],
  ["completed handoff", { handoffWorkItemId: "work-item-existing" }],
  ["handoff failure", { analysisFailure: { phase: "handoff", code: "PR_EMPLOYEE_JOB_FAILED", modelFailure: false } }],
  ["context failure", { analysisFailure: { phase: "context", code: "PR_EMPLOYEE_JOB_FAILED", modelFailure: false } }],
  ["persistence failure", { analysisFailure: { phase: "persistence", code: "PR_EMPLOYEE_JOB_FAILED", modelFailure: false } }],
  ["unknown model failure", { analysisFailure: { phase: "analysis", code: "UNKNOWN_ERROR", modelFailure: false } }],
  ["cleanup failure", { analysisFailure: { phase: "analysis", code: "STRUCTURED_PROVIDER_REAP_FAILED", modelFailure: false } }],
  ["authorization failure", { analysisFailure: { phase: "analysis", code: "REMOTE_DATA_NOT_AUTHORIZED", modelFailure: false } }],
  ["maintenance failure", { analysisFailure: { phase: "analysis", code: "RUNTIME_RESTART_REQUIRED", modelFailure: false } }],
  ["genuine invalid result after backup transport failure", { brain: { provider: "ollama", model: "qwen3.5:9b",
    fallbackFrom: { provider: "codex-login-cli", model: "gpt-5.6-luna", reason: "PR_EMPLOYEE_RESULT_INVALID" } } }],
  ["invalid budget offset", { analysisAttemptBudget: { provider: "ollama", model: "qwen3.5:9b", attemptOffset: 4 } }],
  ["paused job", { status: "paused" }],
  ["dismissed job", { status: "dismissed" }],
  ["unhealthy facts", {}, { sourceStatus: { githubPullRequests: { ok: false } } }],
  ["paused employee", {}, {}, { paused: true }],
]) {
  test(`primary activation does not resume ${name}`, async () => {
    const item = pullRequest();
    const initial = { ...exhaustedOllamaState(item, jobChanges), ...stateChanges };
    const store = new MemoryStore({ snapshot: snapshot([item], snapshotChanges), "pr-employee-state": initial });
    const options = { store, reviewer: routedTriageReviewer({ primary: async () => assert.fail("protected job reached primary") }),
      config: { triageOnly: true }, github: { async loadReviewContext() { assert.fail("protected job reached context"); } },
      triageHandoff: durableTriageHandoff() };
    await createService(options).tick();
    assert.deepEqual((await store.read("pr-employee-state")).jobs, initial.jobs);
  });
}

test("fallback success retains its model when the later durable handoff fails", async () => {
  const item = pullRequest();
  const store = new MemoryStore({ snapshot: snapshot([item]) });
  const reviewer = routedTriageReviewer({ primary: async () => { throw Object.assign(new Error("Primary unavailable"), { code: "STRUCTURED_PROVIDER_UNAVAILABLE" }); },
    fallback: async () => reviewResult({ workType: "triage_plan", reviewVerdict: "none", reviewBody: "", requiresApproval: false }) });
  await createService({ store, reviewer, config: { triageOnly: true }, github: { async loadReviewContext() { return { ...item }; } },
    triageHandoff: { async submit() { throw new Error("ledger unavailable"); } } }).tick();
  const job = (await store.read("pr-employee-state")).jobs[0];
  assert.equal(job.status, "retry_wait");
  assert.equal(job.error, "ledger unavailable");
  assert.equal(job.brain.provider, "ollama");
  assert.equal(job.brain.fallbackFrom.provider, "codex-login-cli");
  assert.deepEqual(job.analysisFailure, { phase: "handoff", code: "PR_EMPLOYEE_JOB_FAILED", modelFailure: false });
});

test("configuration fencing leaves a model-switch recovery blocked without consuming attempts", async () => {
  const item = pullRequest();
  const initial = exhaustedOllamaState(item);
  const store = new MemoryStore({ snapshot: snapshot([item]), "pr-employee-state": initial });
  const gate = readyGate();
  await cutoverToVersion(gate, 2);
  await assert.rejects(createService({ store, reviewer: routedTriageReviewer(), config: { triageOnly: true }, actionAdmissionGate: gate,
    github: { async loadReviewContext() { assert.fail("fenced recovery reached context"); } },
    triageHandoff: durableTriageHandoff() }).tick(), { code: "RUNTIME_RESTART_REQUIRED" });
  assert.deepEqual((await store.read("pr-employee-state")).jobs, initial.jobs);
});

for (const [name, change] of [
  ["Head", { headRefOid: HEAD_43 }],
  ["full Git target", { gitTarget: { ...pullRequest().gitTarget, baseRefOid: "e".repeat(40) } }],
  ["action", { nextAction: "rereview" }],
  ["relation", { relation: "authored", nextAction: "fix_ci" }],
]) {
  test(`model activation supersedes obsolete ${name} instead of recovering the old failed request`, async () => {
    const item = pullRequest();
    const current = pullRequest(change);
    const initial = exhaustedOllamaState(item);
    const store = new MemoryStore({ snapshot: snapshot([current]), "pr-employee-state": initial });
    const requests = [];
    await createService({ store, reviewer: routedTriageReviewer(), config: { triageOnly: true },
      github: { async loadReviewContext() { return { ...current }; } },
      triageHandoff: durableTriageHandoff((request) => requests.push(request)) }).tick();
    const old = (await store.read("pr-employee-state")).jobs.find((job) => job.id === initial.jobs[0].id);
    assert.equal(old.status, "superseded");
    assert.equal(old.attempts, 3);
    assert.equal(old.analysisAttemptBudget, undefined);
    assert.equal(requests.some((request) => request.requestKey === old.id), false);
  });
}

test("PR patrol persists the actual fallback model and restart does not repeat completed analysis", async () => {
  const item = pullRequest();
  const store = new MemoryStore({ snapshot: snapshot([item]) });
  let primaryCalls = 0; let fallbackCalls = 0; let handoffs = 0;
  const reviewer = new RoutedPrEmployeeReviewer({
    primaryBrain: { provider: "codex-login-cli", model: "gpt-5.6-luna", remoteData: { requirements: true, code: true, memory: false } },
    router: { async generate() { primaryCalls += 1; throw Object.assign(new Error("Primary unavailable"), { code: "STRUCTURED_PROVIDER_UNAVAILABLE" }); } },
    fallback: { provider: "ollama", model: "qwen3.5:9b", async analyze() {
      fallbackCalls += 1;
      return reviewResult({ workType: "triage_plan", reviewVerdict: "none", reviewBody: "", requiresApproval: false });
    } },
  });
  const options = { store, reviewer, config: { triageOnly: true },
    github: { async loadReviewContext() { return { ...item }; } },
    triageHandoff: durableTriageHandoff(() => { handoffs += 1; }) };
  await createService(options).tick();
  const state = await store.read("pr-employee-state");
  assert.equal(state.jobs[0].status, "ready");
  assert.deepEqual(state.jobs[0].brain, { provider: "ollama", model: "qwen3.5:9b", fallbackFrom: {
    provider: "codex-login-cli", model: "gpt-5.6-luna", reason: "STRUCTURED_PROVIDER_UNAVAILABLE" } });
  await createService(options).tick();
  assert.deepEqual([primaryCalls, fallbackCalls, handoffs], [1, 1, 1]);
});

test("configuration-first admission creates no legacy PR employee job", async () => {
  const gate = readyGate();
  await cutoverToVersion(gate, 2);
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  let contextCalls = 0;
  let reviewerCalls = 0;
  const service = createService({
    store,
    actionAdmissionGate: gate,
    github: {
      async loadReviewContext() {
        contextCalls += 1;
      },
    },
    reviewer: {
      async analyze() {
        reviewerCalls += 1;
        return reviewResult();
      },
    },
  });

  await assert.rejects(
    service.tick(),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );

  assert.equal(await store.read("pr-employee-state", null), null);
  assert.equal(contextCalls, 0);
  assert.equal(reviewerCalls, 0);
});

test("legacy PR work forwards shutdown and records no retry after cancellation", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const controller = new AbortController();
  const shutdown = Object.assign(new Error("lifecycle shutdown"), {
    code: "LIFECYCLE_SHUTDOWN_ABORTED",
  });
  const contextStarted = deferred();
  let contextSignal = null;
  let reviewerCalls = 0;
  const service = createService({
    store,
    github: {
      async loadReviewContext(_item, options) {
        contextSignal = options.signal;
        contextStarted.resolve();
        return new Promise((_resolve, reject) => {
          const onAbort = () => reject(options.signal.reason);
          options.signal.addEventListener("abort", onAbort, { once: true });
          if (options.signal.aborted) onAbort();
        });
      },
    },
    reviewer: {
      async analyze() {
        reviewerCalls += 1;
        return reviewResult();
      },
    },
  });

  const running = service.tick({ signal: controller.signal });
  await contextStarted.promise;
  controller.abort(shutdown);

  await assert.rejects(running, (error) => error === shutdown);
  assert.strictEqual(contextSignal, controller.signal);
  assert.equal(reviewerCalls, 0);
  const state = await store.read("pr-employee-state");
  assert.equal(state.jobs[0].status, "running");
  assert.equal(state.jobs[0].error, "");
});

test("an admitted job write releases cutover before storage settles", async () => {
  const gate = readyGate();
  const store = new BlockingStateStore(
    { snapshot: snapshot([pullRequest()]) },
    1,
  );
  let reviewerCalls = 0;
  const service = createService({
    store,
    actionAdmissionGate: gate,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        reviewerCalls += 1;
        return reviewResult();
      },
    },
  });

  const tick = service.tick();
  await store.writeStarted.promise;
  const cutover = cutoverToVersion(gate, 2);

  assert.equal(await settlesBefore(cutover), true);
  store.writeRelease.resolve();
  await assert.rejects(
    tick,
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );

  const state = await store.read("pr-employee-state");
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, "queued");
  assert.equal(state.jobs[0].attempts, 0);
  assert.equal(reviewerCalls, 0);
});

test("configuration fencing does not block stale-job reconciliation", async () => {
  const gate = readyGate();
  await cutoverToVersion(gate, 2);
  const oldItem = pullRequest({ headRefOid: HEAD_OLD });
  const store = new MemoryStore({
    snapshot: snapshot([pullRequest()]),
    "pr-employee-state": queuedState(oldItem),
  });
  const service = createService({
    store,
    actionAdmissionGate: gate,
    github: {},
    reviewer: { async analyze() { return reviewResult(); } },
  });

  await assert.rejects(
    service.tick(),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );

  const state = await store.read("pr-employee-state");
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, "superseded");
  assert.equal(state.jobs[0].headRefOid, HEAD_OLD);
});

test("configuration-first running claim leaves queued work and controls available", async () => {
  const gate = readyGate();
  await cutoverToVersion(gate, 2);
  const item = pullRequest();
  const store = new MemoryStore({
    snapshot: snapshot([item]),
    "pr-employee-state": queuedState(item),
  });
  let reviewerCalls = 0;
  const service = createService({
    store,
    actionAdmissionGate: gate,
    github: {},
    reviewer: {
      async analyze() {
        reviewerCalls += 1;
        return reviewResult();
      },
    },
  });

  await assert.rejects(
    service.tick(),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );
  const unchanged = await service.view();
  const paused = await service.control("pause", unchanged.role.revision);

  assert.equal(unchanged.jobs[0].status, "queued");
  assert.equal(unchanged.jobs[0].attempts, 0);
  assert.equal(reviewerCalls, 0);
  assert.equal(paused.role.paused, true);
});

test("a running claim releases cutover before the later brain admission", async () => {
  const gate = readyGate();
  const item = pullRequest();
  const store = new BlockingStateStore(
    {
      snapshot: snapshot([item]),
      "pr-employee-state": queuedState(item),
    },
    2,
  );
  let reviewerCalls = 0;
  const service = createService({
    store,
    actionAdmissionGate: gate,
    github: {
      async loadReviewContext(current) {
        return {
          ...current,
          patch: "diff",
          patchTruncated: false,
          files: [],
        };
      },
    },
    reviewer: {
      provider: "ollama",
      model: "sealed-model",
      async analyze() {
        reviewerCalls += 1;
        return reviewResult();
      },
    },
  });

  const tick = service.tick();
  await store.writeStarted.promise;
  const cutover = cutoverToVersion(gate, 2);

  assert.equal(await settlesBefore(cutover), true);
  store.writeRelease.resolve();
  await assert.rejects(
    tick,
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );

  const state = await store.read("pr-employee-state");
  assert.equal(state.jobs[0].status, "running");
  assert.equal(state.jobs[0].attempts, 1);
  assert.deepEqual(state.jobs[0].brain, {
    provider: "ollama",
    model: "sealed-model",
  });
  assert.equal(reviewerCalls, 0);
});

test("an admitted brain request finishes after cutover without holding the gate", async () => {
  const gate = readyGate();
  const item = pullRequest();
  const store = new MemoryStore({
    snapshot: snapshot([item]),
    "pr-employee-state": queuedState(item),
  });
  const analysisStarted = deferred();
  const analysisRelease = deferred();
  const service = createService({
    store,
    actionAdmissionGate: gate,
    github: {
      async loadReviewContext(current) {
        return {
          ...current,
          patch: "diff",
          patchTruncated: false,
          files: [],
        };
      },
    },
    reviewer: {
      provider: "ollama",
      model: "sealed-model",
      async analyze() {
        analysisStarted.resolve();
        await analysisRelease.promise;
        return reviewResult();
      },
    },
  });

  const tick = service.tick();
  await analysisStarted.promise;
  const cutover = cutoverToVersion(gate, 2);

  assert.equal(await settlesBefore(cutover), true);
  analysisRelease.resolve();
  const completed = await tick;

  assert.equal(completed.jobs[0].status, "ready_for_human");
  assert.equal(completed.jobs[0].attempts, 1);
});

test("service and Ollama brain share one gate without nesting deadlock", async () => {
  const gate = readyGate();
  const item = pullRequest();
  const store = new MemoryStore({
    snapshot: snapshot([item]),
    "pr-employee-state": queuedState(item),
  });
  const requestStarted = deferred();
  const responseRelease = deferred();
  const reviewer = new OllamaPrEmployeeReviewer({
    actionAdmissionGate: gate,
    fetch: async () => {
      requestStarted.resolve();
      await responseRelease.promise;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            message: { content: JSON.stringify(reviewResult()) },
          };
        },
      };
    },
  });
  const service = createService({
    store,
    reviewer,
    actionAdmissionGate: gate,
    github: {
      async loadReviewContext(current) {
        return {
          ...current,
          patch: "diff",
          patchTruncated: false,
          files: [],
        };
      },
    },
  });

  const tick = service.tick();
  await requestStarted.promise;
  const cutover = cutoverToVersion(gate, 2);

  assert.equal(await settlesBefore(cutover), true);
  responseRelease.resolve();
  const completed = await tick;

  assert.equal(completed.jobs[0].status, "ready_for_human");
});

test("a committed analysis write acknowledgement never reruns the brain", async () => {
  const item = pullRequest();
  const store = new LostStateWriteAcknowledgementStore(
    {
      snapshot: snapshot([item]),
      "pr-employee-state": queuedState(item),
    },
    3,
  );
  let reviewerCalls = 0;
  const service = createService({
    store,
    github: {
      async loadReviewContext(current) {
        return {
          ...current,
          patch: "diff",
          patchTruncated: false,
          files: [],
        };
      },
    },
    reviewer: {
      async analyze() {
        reviewerCalls += 1;
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "ready_for_human");
  assert.equal(result.jobs[0].attempts, 1);
  assert.equal(reviewerCalls, 1);
  assert.equal(
    (await store.read("pr-employee-state")).jobs[0].status,
    "ready_for_human",
  );
});

test("an expired running lease rebinds to only the restarted brain", async () => {
  const item = pullRequest();
  const stored = queuedState(item);
  stored.jobs[0] = {
    ...stored.jobs[0],
    status: "running",
    attempts: 1,
    startedAt: "2026-07-31T09:58:00.000Z",
    leaseUntil: "2026-07-31T10:00:00.000Z",
    brain: { provider: "ollama", model: "old-model" },
  };
  const store = new MemoryStore({
    snapshot: snapshot([item]),
    "pr-employee-state": stored,
  });
  let newBrainCalls = 0;
  const service = createService({
    store,
    actionAdmissionGate: readyGate(2),
    github: {
      async loadReviewContext(current) {
        return {
          ...current,
          patch: "diff",
          patchTruncated: false,
          files: [],
        };
      },
    },
    reviewer: {
      provider: "ollama",
      model: "new-model",
      async analyze() {
        newBrainCalls += 1;
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "ready_for_human");
  assert.equal(result.jobs[0].attempts, 2);
  assert.deepEqual(result.jobs[0].brain, {
    provider: "ollama",
    model: "new-model",
  });
  assert.equal(newBrainCalls, 1);
});

test("an active running lease never reaches a restarted brain", async () => {
  const item = pullRequest();
  const stored = queuedState(item);
  stored.jobs[0] = {
    ...stored.jobs[0],
    status: "running",
    attempts: 1,
    startedAt: "2026-07-31T10:00:00.000Z",
    leaseUntil: "2026-07-31T10:02:00.000Z",
    brain: { provider: "ollama", model: "old-model" },
  };
  const store = new MemoryStore({
    snapshot: snapshot([item]),
    "pr-employee-state": stored,
  });
  let reviewerCalls = 0;
  const service = createService({
    store,
    actionAdmissionGate: readyGate(2),
    github: {},
    reviewer: {
      async analyze() {
        reviewerCalls += 1;
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "running");
  assert.equal(result.jobs[0].attempts, 1);
  assert.equal(reviewerCalls, 0);
});

test("a lost running-claim acknowledgement waits for one lease recovery", async () => {
  const item = pullRequest();
  const store = new LostStateWriteAcknowledgementStore(
    {
      snapshot: snapshot([item]),
      "pr-employee-state": queuedState(item),
    },
    2,
  );
  let oldBrainCalls = 0;
  const first = createService({
    store,
    actionAdmissionGate: readyGate(),
    github: {},
    reviewer: {
      async analyze() {
        oldBrainCalls += 1;
        return reviewResult();
      },
    },
  });

  await assert.rejects(first.tick(), /acknowledgement lost/);
  const uncertain = await store.read("pr-employee-state");
  assert.equal(uncertain.jobs[0].status, "running");
  assert.equal(uncertain.jobs[0].attempts, 1);
  assert.equal(oldBrainCalls, 0);

  let recoveredBrainCalls = 0;
  const restarted = createService({
    store,
    now: "2026-07-31T10:03:00.000Z",
    actionAdmissionGate: readyGate(2),
    github: {
      async loadReviewContext(current) {
        return {
          ...current,
          patch: "diff",
          patchTruncated: false,
          files: [],
        };
      },
    },
    reviewer: {
      provider: "ollama",
      model: "restarted-model",
      async analyze() {
        recoveredBrainCalls += 1;
        return reviewResult();
      },
    },
  });

  const recovered = await restarted.tick();

  assert.equal(recovered.jobs[0].status, "ready_for_human");
  assert.equal(recovered.jobs[0].attempts, 2);
  assert.equal(recovered.jobs[0].brain.model, "restarted-model");
  assert.equal(recoveredBrainCalls, 1);
});

test("a reassigned same-Head review automatically gets a new handoff after report-only triage", async () => {
  const item = pullRequest({ nextAction: "complete_review", currentUser: "runtime-user", assignees: ["runtime-user"], isDraft: false, ciStatus: "NONE",
    incomingReviewFactsAvailable: true, reviewRecipient: "runtime-user", reviewReceivedFrom: "someone-else",
    reviewReceivedVia: "assignee", reviewRequestEventId: "assign-again", reviewReceivedAt: "2026-07-31T09:00:00Z",
    myReviewState: "COMMENTED", myReviewCommitOid: HEAD_42, myLatestPublishedReviewState: "COMMENTED",
    myLatestPublishedReviewCommitOid: HEAD_42, myLatestPublishedReviewAt: "2026-07-30T10:00:00Z" });
  const store = new MemoryStore({ snapshot: snapshot([item]) });
  const handoffs = [];
  const service = createService({ store, config: { triageOnly: true, automaticReviewPolicy: { enabled: true, account: "runtime-user" } },
    github: { async loadReviewContext() { return { ...item }; }, async readIncomingReviewRequest() { return { ...item }; } },
    reviewer: { provider: "ollama", model: "triage-model", async analyze() {
      return reviewResult({ workType: "triage_plan", reviewVerdict: "none", reviewBody: "", requiresApproval: false });
    } },
    triageHandoff: durableTriageHandoff(input => handoffs.push(input)) });
  await service.tick();
  assert.equal(handoffs.length, 1);
  Object.assign(item, assessPullRequestResponsibility(item, { now: "2026-07-31T10:01:00Z" }));
  await store.write("snapshot", snapshot([item]));
  await service.tick();
  assert.equal(handoffs.length, 2);
  assert.equal(handoffs[1].nextAction, "rereview");
  assert.equal(handoffs[1].expectedHeadRefOid, handoffs[0].expectedHeadRefOid);
  assert.notEqual(handoffs[1].requestKey, handoffs[0].requestKey);
  await service.tick();
  assert.equal(handoffs.length, 2);
});

test("a same-head action change is superseded before context reaches the brain", async () => {
  const item = pullRequest();
  const changed = pullRequest({ nextAction: "complete_review" });
  const store = new SnapshotChangingOnClaimStore(
    {
      snapshot: snapshot([item]),
      "pr-employee-state": queuedState(item),
    },
    snapshot([changed]),
  );
  let contextCalls = 0;
  let reviewerCalls = 0;
  const service = createService({
    store,
    github: {
      async loadReviewContext() {
        contextCalls += 1;
      },
    },
    reviewer: {
      async analyze() {
        reviewerCalls += 1;
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "superseded");
  assert.equal(contextCalls, 0);
  assert.equal(reviewerCalls, 0);
});

test("runtime admission failures leave the running claim recoverable", async () => {
  const item = pullRequest();
  const store = new MemoryStore({
    snapshot: snapshot([item]),
    "pr-employee-state": queuedState(item),
  });
  const service = createService({
    store,
    github: {
      async loadReviewContext(current) {
        return {
          ...current,
          patch: "diff",
          patchTruncated: false,
          files: [],
        };
      },
    },
    reviewer: {
      async analyze() {
        throw Object.assign(new Error("restart required"), {
          code: "RUNTIME_RESTART_REQUIRED",
        });
      },
    },
  });

  await assert.rejects(
    service.tick(),
    (error) => error.code === "RUNTIME_RESTART_REQUIRED",
  );

  const state = await store.read("pr-employee-state");
  assert.equal(state.jobs[0].status, "running");
  assert.equal(state.jobs[0].attempts, 1);
  assert.equal(state.jobs[0].error, "");
});

test("an explicit invalid legacy employee admission gate fails closed", () => {
  assert.throws(
    () => createService({
      store: new MemoryStore(),
      actionAdmissionGate: null,
    }),
    /actionAdmissionGate must provide run/,
  );
});

test("a fresh installation can reserve the legacy PR employee in paused state", async () => {
  const store = new MemoryStore();
  const service = createService({
    store,
    github: {},
    reviewer: null,
    config: { initialPaused: true },
  });

  const view = await service.view();

  assert.equal(view.role.paused, true);
  assert.equal(view.role.state, "paused");
  assert.equal(view.role.revision, 0);
  assert.deepEqual(view.jobs, []);
});

test("a new review head is analyzed proactively once and queued for human review", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const loaded = [];
  const reviewed = [];
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        loaded.push(item.headRefOid);
        return {
          ...item,
          patch: "diff --git a/checkout.js b/checkout.js",
          patchTruncated: false,
          files: [{ path: "checkout.js", additions: 8, deletions: 2 }],
        };
      },
    },
    reviewer: {
      provider: "ollama",
      model: "qwen3.5:9b",
      async analyze(context) {
        reviewed.push(context.headRefOid);
        return reviewResult();
      },
    },
  });

  const first = await service.tick({ trigger: "refresh_completed" });
  const second = await service.tick({ trigger: "scheduled" });

  assert.deepEqual(loaded, [HEAD_42]);
  assert.deepEqual(reviewed, [HEAD_42]);
  assert.equal(first.jobs[0].status, "ready_for_human");
  assert.equal(first.confirmationQueue.length, 1);
  assert.equal(first.confirmationQueue[0].reviewBody, reviewResult().reviewBody);
  assert.equal(second.jobs.length, 1);
  assert.equal(second.role.lastRun.newJobs, 0);
  assert.equal(second.role.state, "waiting_user");
});

test("job identity and approval policy cannot be overridden by a reviewer", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        return reviewResult({
          id: "forged-id",
          subjectId: "forged-subject",
          status: "accepted",
          workType: "owner_plan",
          requiresApproval: false,
        });
      },
    },
  });

  const result = await service.tick();

  assert.match(result.jobs[0].id, /^pr-work-/);
  assert.equal(result.jobs[0].subjectId, pullRequest().id);
  assert.equal(result.jobs[0].workType, "review_draft");
  assert.equal(result.jobs[0].requiresApproval, true);
  assert.equal(result.jobs[0].status, "ready_for_human");
});

test("a policy upgrade supersedes the old draft before creating a replacement", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const github = {
    async loadReviewContext(item) {
      return { ...item, patch: "diff", patchTruncated: false, files: [] };
    },
  };
  const reviewer = { async analyze() { return reviewResult(); } };

  await createService({ store, github, reviewer }).tick();
  const upgraded = await createService({
    store,
    github,
    reviewer,
    config: { policyVersion: 2 },
  }).tick();

  assert.equal(upgraded.jobs.length, 2);
  assert.equal(
    upgraded.jobs.filter((job) => job.status === "superseded").length,
    1,
  );
  assert.equal(upgraded.confirmationQueue.length, 1);
  assert.equal(upgraded.confirmationQueue[0].policyVersion, 2);
});

test("an authored PR produces an internal work plan without entering approval", async () => {
  const owned = pullRequest({
    relation: "authored",
    author: "local-owner",
    nextAction: "address_review",
    actionReasons: ["需要处理评审意见"],
  });
  const store = new MemoryStore({ snapshot: snapshot([owned]) });
  const service = createService({
    store,
    config: { automaticOwnPrRepair: true },
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "failure handling diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      provider: "ollama",
      model: "qwen3.5:9b",
      async analyze() {
        return reviewResult({
          workType: "owner_plan",
          reviewVerdict: "none",
          reviewBody: "",
          requiresApproval: false,
        });
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "ready");
  assert.equal(result.confirmationQueue.length, 0);
  assert.equal(result.role.lastRun.newJobs, 1);
});

test("triage-only PR promoter classifies work without reading patches or drafting Reviews", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  let includePatch = null;
  let analysisContext = null;
  let handoffInput = null;
  const service = createService({
    store,
    config: { triageOnly: true, automaticOwnPrRepair: true },
    triageHandoff: durableTriageHandoff((input) => {
      handoffInput = input;
    }),
    github: {
      async loadReviewContext(item, options) {
        includePatch = options.includePatch;
        return { ...item, patch: "", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      provider: "ollama",
      model: "qwen3.5:9b",
      async analyze(context) {
        analysisContext = context;
        return reviewResult({
          workType: "triage_plan",
          reviewVerdict: "none",
          reviewBody: "",
          requiresApproval: false,
        });
      },
    },
  });

  const result = await service.tick();

  assert.equal(includePatch, false);
  assert.equal(analysisContext.workMode, "triage");
  assert.equal(result.jobs[0].workType, "triage_plan");
  assert.equal(result.jobs[0].targetRoleId, "pr-engineer");
  assert.equal(result.jobs[0].handoffWorkItemId, "work-item-pr-engineer");
  assert.deepEqual(handoffInput, {
    requestKey: result.jobs[0].id,
    targetRoleId: "pr-engineer",
    repository: "acme/repo",
    number: 42,
    nextAction: "review",
    expectedHeadRefOid: HEAD_42,
    gitTarget: pullRequest().gitTarget,
  });
  assert.equal(result.jobs[0].reviewVerdict, "none");
  assert.equal(result.jobs[0].reviewBody, "");
  assert.equal(result.jobs[0].requiresApproval, false);
  assert.equal(result.jobs[0].status, "ready");
  assert.equal(result.confirmationQueue.length, 0);
});

test("automatic Review triage checks live completion and assignment before creating another root", async (t) => {
  for (const change of ['published', 'unassigned', 'head-changed', 'unchanged']) await t.test(change, async () => {
    const item = pullRequest({ isDraft: false, assignees: ['runtime-user'], incomingReviewFactsAvailable: true });
    const store = new MemoryStore({ snapshot: snapshot([item]) });
    const facts = { ...item, currentUser: 'runtime-user' };
    let reads = 0, handoffs = 0;
    const service = createService({
      store,
      config: { triageOnly: true, automaticReviewPolicy: { enabled: true, account: 'runtime-user' } },
      triageHandoff: durableTriageHandoff(() => { handoffs++; }),
      github: {
        async loadReviewContext() { return { ...item, patch: '', files: [] }; },
        async readIncomingReviewRequest(input) {
          assert.deepEqual(input, { repository: item.repo, number: item.number, account: 'runtime-user' });
          reads++;
          return structuredClone(facts);
        },
      },
      reviewer: { async analyze() {
        if (change === 'published') facts.myLatestPublishedReviewCommitOid = item.headRefOid;
        if (change === 'unassigned') facts.assignees = ['qa-user'];
        if (change === 'head-changed') facts.headRefOid = HEAD_43;
        return reviewResult({ workType: 'triage_plan', reviewVerdict: 'none', reviewBody: '', requiresApproval: false });
      } },
    });
    const result = await service.tick();
    assert.equal(handoffs, change === 'unchanged' ? 1 : 0);
    assert.equal(reads, 1);
    assert.equal(result.jobs[0].status, change === 'unchanged' ? 'ready' : 'superseded');
    // The dashboard snapshot deliberately remains unchanged throughout analysis.
    assert.deepEqual((await store.read('snapshot')).items[0], item);
  });
});

test("unavailable live Review facts retry triage without creating or retiring work", async (t) => {
  const invalid = {
    unavailable: () => ({ incomingReviewFactsAvailable: false }),
    'wrong-target': facts => ({ ...facts, repo: 'other/repo' }),
    'wrong-account': facts => ({ ...facts, currentUser: 'other-user' }),
    'unknown-state': facts => ({ ...facts, state: 'unknown' }),
    'missing-assignees': facts => ({ ...facts, assignees: undefined }),
    'malformed-author': facts => ({ ...facts, author: '?' }),
    'malformed-head': facts => ({ ...facts, headRefOid: 'unknown' }),
  };
  for (const [name, change] of Object.entries(invalid)) await t.test(name, async () => {
    const item = pullRequest({ isDraft: false, assignees: ['runtime-user'], incomingReviewFactsAvailable: true });
    let handoffs = 0;
    const service = createService({
      store: new MemoryStore({ snapshot: snapshot([item]) }),
      config: { triageOnly: true, automaticReviewPolicy: { enabled: true, account: 'runtime-user' } },
      triageHandoff: durableTriageHandoff(() => { handoffs++; }),
      github: {
        async loadReviewContext() { return { ...item, patch: '', files: [] }; },
        async readIncomingReviewRequest() { return change({ ...item, currentUser: 'runtime-user' }); },
      },
      reviewer: { async analyze() { return reviewResult({ workType: 'triage_plan' }); } },
    });
    const result = await service.tick();
    assert.equal(handoffs, 0);
    assert.equal(result.jobs[0].status, 'retry_wait');
    assert.equal(result.jobs[0].analysisFailure.phase, 'handoff');
    assert.equal(result.jobs[0].analysisFailure.code, 'PR_LIVE_REVIEW_FACTS_UNAVAILABLE');
  });
});

test("triage-only PR promoter durably routes authored fixes to developer", async () => {
  const owned = pullRequest({
    relation: "authored",
    author: "local-owner",
    nextAction: "fix_ci",
    actionReasons: ["需要你处理检查失败"],
  });
  const store = new MemoryStore({ snapshot: snapshot([owned]) });
  const handoffs = [];
  const service = createService({
    store,
    config: { triageOnly: true, automaticOwnPrRepair: true },
    triageHandoff: durableTriageHandoff((input) => handoffs.push(input)),
    github: {
      async loadReviewContext(item, options) {
        assert.equal(options.includePatch, false);
        return { ...item, patch: "", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        return reviewResult({
          workType: "triage_plan",
          reviewVerdict: "none",
          reviewBody: "",
          requiresApproval: false,
        });
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].targetRoleId, "developer");
  assert.equal(result.jobs[0].handoffWorkItemId, "work-item-developer");
  assert.equal(result.confirmationQueue.length, 0);
  assert.deepEqual(handoffs[0], {
    requestKey: result.jobs[0].id,
    targetRoleId: "developer",
    repository: "acme/repo",
    number: 42,
    nextAction: "fix_ci",
    expectedHeadRefOid: HEAD_42,
  });
});

test("automatic own PR repair keeps legacy triage from creating competing owner requests", async (t) => {
  for (const nextAction of ["address_review", "resolve_conflict"]) await t.test(nextAction, async () => {
  const owned = pullRequest({
    relation: "authored",
    author: "local-owner",
    nextAction,
  });
  const store = new MemoryStore({ snapshot: snapshot([owned]) });
  const service = createService({
    store,
    config: { triageOnly: true, automaticOwnPrRepair: true },
    triageHandoff: { async submit() { assert.fail("automatic repair owns this PR"); } },
    github: { async loadReviewContext() { assert.fail("legacy triage must not read it"); } },
    reviewer: { async analyze() { assert.fail("legacy triage must not analyze it"); } },
  });

  for (let tick = 0; tick < 2; tick += 1) {
    const result = await service.tick();
    assert.deepEqual(result.jobs, []);
    assert.equal(result.role.lastRun.newJobs, 0);
  }
  });
});

test("automatic own PR repair retires pending legacy triage without pretending repair completed", async (t) => {
  for (const status of ["queued", "retry_wait", "blocked", "ready"]) {
    await t.test(status, async () => {
      const owned = pullRequest({ relation: "authored", nextAction: "address_review" });
      const store = new MemoryStore({
        snapshot: snapshot([owned]),
        "pr-employee-state": queuedState(owned, {
          policyVersion: 3,
          status,
          attempts: 2,
          error: "previous transport failure",
          nextAttemptAt: "2026-07-31T09:00:00.000Z",
        }),
      });
      const service = createService({
        store,
        config: { triageOnly: true, automaticOwnPrRepair: true },
        triageHandoff: { async submit() { assert.fail("no competing handoff"); } },
        reviewer: { async analyze() { assert.fail("no legacy retry"); } },
      });

      const result = await service.tick();
      assert.equal(result.jobs.length, 1);
      assert.equal(result.jobs[0].status, "superseded");
      assert.equal(result.jobs[0].attempts, 2);
      assert.equal(result.jobs[0].handoffWorkItemId, undefined);
      assert.equal(result.role.lastError, "");
    });
  }
});

test("automatic own PR repair prevents manual retries from reviving a competing legacy job", async () => {
  const owned = pullRequest({ relation: "authored", nextAction: "address_review" });
  const store = new MemoryStore({
    snapshot: snapshot([owned]),
    "pr-employee-state": queuedState(owned, { policyVersion: 3, status: "blocked" }),
  });
  const service = createService({
    store,
    config: { triageOnly: true, automaticOwnPrRepair: true },
    triageHandoff: durableTriageHandoff(),
  });

  await assert.rejects(
    service.resolveBlockedJob("pr-work-existing", "retry", {
      headRefOid: HEAD_42, expectedRevision: 3,
    }),
    (error) => error.statusCode === 409,
  );
  assert.equal((await service.view()).jobs[0].status, "superseded");
});

test("legacy triage still hands off review feedback when automatic repair is disabled", async (t) => {
  for (const automaticOwnPrRepair of [false, undefined, "true"]) {
    await t.test(String(automaticOwnPrRepair), async () => {
      const owned = pullRequest({
        relation: "authored", nextAction: "address_review", automaticOwnPrRepair: true,
      });
      const handoffs = [];
      const service = createService({
        store: new MemoryStore({ snapshot: snapshot([owned]) }),
        config: { triageOnly: true, automaticOwnPrRepair },
        triageHandoff: durableTriageHandoff((input) => handoffs.push(input)),
        github: { async loadReviewContext(item) { return item; } },
        reviewer: { async analyze() { return reviewResult({
          workType: "triage_plan", reviewVerdict: "none", reviewBody: "", requiresApproval: false,
        }); } },
      });

      const result = await service.tick();
      assert.equal(handoffs.length, 1);
      assert.equal(handoffs[0].nextAction, "address_review");
      assert.equal(result.jobs[0].status, "ready");
      assert.equal(result.jobs[0].handoffWorkItemId, "work-item-developer");
    });
  }
});

test("triage-only PR promoter does not finish when durable handoff fails", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const service = createService({
    store,
    config: { triageOnly: true },
    triageHandoff: {
      async submit() {
        throw Object.assign(new Error("ledger unavailable"), {
          code: "PR_TRIAGE_HANDOFF_NOT_READY",
        });
      },
    },
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        return reviewResult({
          workType: "triage_plan",
          reviewVerdict: "none",
          reviewBody: "",
          requiresApproval: false,
        });
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "retry_wait");
  assert.equal(result.jobs[0].error, "ledger unavailable");
  assert.equal(result.jobs[0].handoffWorkItemId, undefined);
});

test("enabling triage retires legacy Review drafts before creating triage work", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const github = {
    async loadReviewContext(item) {
      return { ...item, patch: "", patchTruncated: false, files: [] };
    },
  };
  await createService({
    store,
    github,
    reviewer: { async analyze() { return reviewResult(); } },
  }).tick();

  const result = await createService({
    store,
    github,
    config: { triageOnly: true },
    triageHandoff: durableTriageHandoff(),
    reviewer: {
      async analyze() {
        return reviewResult({
          workType: "triage_plan",
          reviewVerdict: "none",
          reviewBody: "",
          requiresApproval: false,
        });
      },
    },
  }).tick();

  assert.equal(
    result.jobs.filter((job) => job.workType === "review_draft")[0].status,
    "superseded",
  );
  assert.equal(
    result.jobs.filter((job) => job.workType === "triage_plan")[0].status,
    "ready",
  );
  assert.equal(result.confirmationQueue.length, 0);
});

test("pausing is persistent and prevents new analysis until resumed", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  let calls = 0;
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        calls += 1;
        return reviewResult();
      },
    },
  });

  const initial = await service.view();
  const paused = await service.control("pause", initial.role.revision);
  await service.tick();
  const resumed = await service.control("resume", paused.role.revision);
  await service.tick({ trigger: "resume" });

  assert.equal(paused.role.state, "paused");
  assert.equal(resumed.role.state, "observing");
  assert.equal(calls, 1);
});

test("existing PR employee state remains readable after controller migration", async () => {
  const existingState = {
    revision: 17,
    paused: true,
    jobs: [
      {
        id: "pr-work-existing",
        subjectId: pullRequest().id,
        status: "ready_for_human",
        createdAt: "2026-07-30T08:00:00.000Z",
      },
    ],
    memoryOutbox: [],
    memoryOutboxError: "",
    memoryOutboxDropped: 0,
    lastRun: null,
    lastError: "",
  };
  const store = new MemoryStore({ "pr-employee-state": existingState });

  const restored = await createService({ store }).view();

  assert.equal(restored.role.id, "pr-reviewer");
  assert.equal(restored.role.revision, 17);
  assert.equal(restored.role.paused, true);
  assert.equal(restored.jobs[0].id, "pr-work-existing");
  assert.equal(restored.confirmationQueue.length, 1);
});

test("a head change during model work supersedes the stale result", async () => {
  const original = pullRequest();
  const store = new MemoryStore({ snapshot: snapshot([original]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        await store.write("snapshot", snapshot([
          pullRequest({ headRefOid: HEAD_43 }),
        ]));
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "superseded");
  assert.equal(result.confirmationQueue.length, 0);
});

test("an incomplete live Git target cannot start the legacy PR employee", async () => {
  const incomplete = pullRequest({ gitTargetAvailable: false });
  const store = new MemoryStore({ snapshot: snapshot([incomplete]) });
  let contextCalls = 0;
  let reviewerCalls = 0;
  const service = createService({
    store,
    github: {
      async loadReviewContext() {
        contextCalls += 1;
      },
    },
    reviewer: {
      async analyze() {
        reviewerCalls += 1;
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs.length, 0);
  assert.equal(contextCalls, 0);
  assert.equal(reviewerCalls, 0);
});

test("a same-Head Git target change during model work supersedes the stale result", async () => {
  const original = pullRequest();
  const changed = pullRequest({
    gitTarget: {
      ...original.gitTarget,
      baseRefOid: "e".repeat(40),
    },
  });
  const store = new MemoryStore({ snapshot: snapshot([original]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: {
      async analyze() {
        await store.write("snapshot", snapshot([changed]));
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "superseded");
  assert.equal(result.confirmationQueue.length, 0);
});

test("a stale review-context read supersedes immediately without retrying", async () => {
  const item = pullRequest();
  const store = new MemoryStore({ snapshot: snapshot([item]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext() {
        throw Object.assign(new Error("stale"), { code: "PR_CONTEXT_STALE" });
      },
    },
    reviewer: { async analyze() { return reviewResult(); } },
  });

  const result = await service.tick();

  assert.equal(result.jobs[0].status, "superseded");
  assert.equal(result.jobs[0].attempts, 1);
  assert.equal(result.jobs[0].nextAttemptAt, undefined);
});

test("fallback GitHub data never starts a proactive job", async () => {
  const store = new MemoryStore({
    snapshot: snapshot([pullRequest()], {
      sourceStatus: { githubPullRequests: { ok: false, stale: true } },
    }),
  });
  let calls = 0;
  const service = createService({
    store,
    github: {},
    reviewer: {
      async analyze() {
        calls += 1;
        return reviewResult();
      },
    },
  });

  const result = await service.tick();

  assert.equal(calls, 0);
  assert.equal(result.jobs.length, 0);
  assert.match(result.role.lastRun.summary, /GitHub.*未刷新/);
});

test("review decisions are local, revision guarded, and searchable in memory", async () => {
  const store = new MemoryStore({ snapshot: snapshot([pullRequest()]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: { async analyze() { return reviewResult(); } },
  });
  const ready = await service.tick();
  const job = ready.jobs[0];

  await assert.rejects(
    service.decide(job.id, "accept", {
      headRefOid: job.headRefOid,
      expectedRevision: ready.role.revision - 1,
    }),
    (error) => error.statusCode === 409,
  );

  const accepted = await service.decide(job.id, "accept", {
    headRefOid: job.headRefOid,
    expectedRevision: ready.role.revision,
  });
  const memories = await service.searchMemory("失败路径");

  assert.equal(accepted.jobs[0].status, "accepted");
  assert.equal(accepted.confirmationQueue.length, 0);
  assert.ok(memories.some((memory) => memory.sourceId === job.subjectId));
});

test("memory persistence failures do not roll completed work back into retry", async () => {
  class FailingMemoryStore extends MemoryStore {
    async write(name, value) {
      if (name === "pr-employee-memory") {
        throw new Error("memory disk unavailable");
      }
      await super.write(name, value);
    }
  }

  const store = new FailingMemoryStore({ snapshot: snapshot([pullRequest()]) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: { async analyze() { return reviewResult(); } },
  });

  const ready = await service.tick();
  const job = ready.jobs[0];
  const accepted = await service.decide(job.id, "accept", {
    headRefOid: job.headRefOid,
    expectedRevision: ready.role.revision,
  });
  const memories = await service.searchMemory("失败路径");

  assert.equal(job.status, "ready_for_human");
  assert.equal(job.attempts, 1);
  assert.equal(accepted.jobs[0].status, "accepted");
  assert.equal(accepted.role.state, "degraded");
  assert.match(accepted.role.lastError, /记忆队列写入失败/);
  assert.ok(memories.some((memory) => memory.sourceId === job.subjectId));
});

test("a prolonged memory outage keeps the outbox bounded", async () => {
  class FailingMemoryStore extends MemoryStore {
    async write(name, value) {
      if (name === "pr-employee-memory") throw new Error("disk unavailable");
      await super.write(name, value);
    }
  }
  const requests = [1, 2, 3].map((number) =>
    pullRequest({
      id: `github:pr:acme/repo#${number}`,
      number,
      headRefOid: number.toString(16).padStart(40, "0"),
    }),
  );
  const store = new FailingMemoryStore({ snapshot: snapshot(requests) });
  const service = createService({
    store,
    github: {
      async loadReviewContext(item) {
        return { ...item, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: { async analyze() { return reviewResult(); } },
    config: { maxJobsPerTick: 3, memoryOutboxLimit: 2 },
  });

  const result = await service.tick();
  const state = await store.read("pr-employee-state");

  assert.equal(result.jobs.length, 3);
  assert.equal(state.memoryOutbox.length, 2);
  assert.equal(state.memoryOutboxDropped, 1);
});

test("a healthy patrol retires a stale analysis failure and restores role health", async () => {
  const failedItem = pullRequest({ headRefOid: HEAD_OLD });
  const store = new MemoryStore({
    snapshot: snapshot([]),
    "pr-employee-state": queuedState(failedItem, {
      status: "blocked",
      attempts: 3,
      error: "Invalid Ollama employee result after retry",
    }),
  });
  const service = createService({
    store,
    github: {
      async loadReviewContext() {
        throw new Error("stale blocked work must not reload PR context");
      },
    },
    reviewer: {
      async analyze() {
        throw new Error("stale blocked work must not reach the brain");
      },
    },
  });

  const result = await service.tick({ trigger: "scheduled" });

  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].status, "superseded");
  assert.equal(result.role.state, "observing");
  assert.equal(result.role.lastError, "");
});

test("the owner can retry a current analysis failure without bypassing identity checks", async () => {
  const item = pullRequest();
  const store = new MemoryStore({
    snapshot: snapshot([item]),
    "pr-employee-state": queuedState(item, {
      status: "blocked",
      attempts: 3,
      error: "Invalid Ollama employee result after retry",
    }),
  });
  const service = createService({
    store,
    github: {
      async loadReviewContext(candidate) {
        return { ...candidate, patch: "diff", patchTruncated: false, files: [] };
      },
    },
    reviewer: { async analyze() { return reviewResult(); } },
  });

  const queued = await service.resolveBlockedJob("pr-work-existing", "retry", {
    headRefOid: item.headRefOid,
    expectedRevision: 3,
  });

  assert.equal(queued.jobs[0].status, "queued");
  assert.equal(queued.jobs[0].attempts, 0);
  assert.equal(queued.jobs[0].error, "");
  const completed = await service.tick({ trigger: "manual_retry" });
  assert.equal(completed.jobs[0].status, "ready_for_human");
  assert.equal(completed.jobs[0].attempts, 1);
});

test("an unhealthy GitHub snapshot cannot retire or retry an analysis failure", async () => {
  const item = pullRequest();
  const initialState = queuedState(item, {
    status: "blocked",
    attempts: 3,
    error: "Invalid Ollama employee result after retry",
  });
  const store = new MemoryStore({
    snapshot: snapshot([item], {
      sourceStatus: { githubPullRequests: { ok: false, stale: true } },
    }),
    "pr-employee-state": initialState,
  });
  const service = createService({ store });

  await assert.rejects(
    service.resolveBlockedJob("pr-work-existing", "retry", {
      headRefOid: item.headRefOid,
      expectedRevision: 3,
    }),
    { statusCode: 503 },
  );

  assert.deepEqual(await store.read("pr-employee-state"), initialState);
});

test("analysis-failure recovery rejects stale owner intent before changing the job", async () => {
  const item = pullRequest();
  const initialState = queuedState(item, {
    status: "blocked",
    attempts: 3,
    error: "Invalid Ollama employee result after retry",
  });

  for (const options of [
    { headRefOid: item.headRefOid, expectedRevision: 2 },
    { headRefOid: HEAD_OLD, expectedRevision: 3 },
  ]) {
    const store = new MemoryStore({
      snapshot: snapshot([item]),
      "pr-employee-state": initialState,
    });
    const service = createService({ store });

    await assert.rejects(
      service.resolveBlockedJob("pr-work-existing", "retry", options),
      { statusCode: 409 },
    );
    assert.deepEqual(await store.read("pr-employee-state"), initialState);
  }
});

test("a healthy identity mismatch retires the old analysis failure", async () => {
  const item = pullRequest();
  const changed = pullRequest({ headRefOid: HEAD_OLD });
  const store = new MemoryStore({
    snapshot: snapshot([changed]),
    "pr-employee-state": queuedState(item, {
      status: "blocked",
      attempts: 3,
      error: "Invalid Ollama employee result after retry",
    }),
  });
  const service = createService({ store });

  await assert.rejects(
    service.resolveBlockedJob("pr-work-existing", "retry", {
      headRefOid: item.headRefOid,
      expectedRevision: 3,
    }),
    { statusCode: 409 },
  );

  const state = await store.read("pr-employee-state");
  assert.equal(state.jobs[0].status, "superseded");
  assert.equal(state.revision, 4);
});

test("a policy change retires an analysis failure created under the old policy", async () => {
  const item = pullRequest();
  const store = new MemoryStore({
    snapshot: snapshot([item]),
    "pr-employee-state": queuedState(item, {
      status: "blocked",
      attempts: 3,
      error: "Invalid Ollama employee result after retry",
    }),
  });
  const service = createService({ store, config: { policyVersion: 2 } });

  await assert.rejects(
    service.resolveBlockedJob("pr-work-existing", "dismiss", {
      headRefOid: item.headRefOid,
      expectedRevision: 3,
    }),
    { statusCode: 409 },
  );

  const state = await store.read("pr-employee-state");
  assert.equal(state.jobs[0].status, "superseded");
});

test("the owner can dismiss one current analysis failure without creating it again", async () => {
  const item = pullRequest();
  const store = new MemoryStore({
    snapshot: snapshot([item]),
    "pr-employee-state": queuedState(item, {
      status: "blocked",
      attempts: 3,
      error: "Invalid Ollama employee result after retry",
    }),
  });
  const service = createService({
    store,
    github: {
      async loadReviewContext() {
        throw new Error("dismissed work must not reload PR context");
      },
    },
    reviewer: {
      async analyze() {
        throw new Error("dismissed work must not reach the brain");
      },
    },
  });

  const dismissed = await service.resolveBlockedJob(
    "pr-work-existing",
    "dismiss",
    {
      headRefOid: item.headRefOid,
      expectedRevision: 3,
    },
  );

  assert.equal(dismissed.jobs[0].status, "dismissed");
  assert.equal(dismissed.jobs[0].decision, "dismiss");
  assert.equal(dismissed.role.state, "observing");
  assert.equal(dismissed.role.lastError, "");
  const next = await service.tick({ trigger: "scheduled" });
  assert.equal(next.jobs.length, 1);
  assert.equal(next.jobs[0].status, "dismissed");
  assert.equal(next.role.lastRun.newJobs, 0);
});

test("either unknown-external-outcome marker blocks analysis-failure recovery", async () => {
  const item = pullRequest();
  for (const marker of [
    { confirmationId: "confirmation-review-42" },
    {
      confirmationFailure: {
        code: "UNKNOWN",
        message: "outcome unknown",
        outcome: "unknown",
        retryable: false,
      },
    },
  ]) {
    const blocked = queuedState(item, {
      status: "blocked",
      attempts: 1,
      error: "外部动作结果无法确认：UNKNOWN",
      ...marker,
    });
    const store = new MemoryStore({
      snapshot: snapshot([item]),
      "pr-employee-state": blocked,
    });
    const service = createService({ store });

    await assert.rejects(
      service.resolveBlockedJob("pr-work-existing", "retry", {
        headRefOid: item.headRefOid,
        expectedRevision: 3,
      }),
      { statusCode: 409 },
    );
    const unchanged = await service.view();
    assert.equal(unchanged.jobs[0].status, "blocked");
    assert.equal(unchanged.role.state, "degraded");
  }
});
