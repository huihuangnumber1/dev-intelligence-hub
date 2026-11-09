import assert from "node:assert/strict";
import test from "node:test";
import { RefreshService } from "../src/services/refresh-service.js";
import { WorkflowFactSource } from "../src/services/workflow-fact-source.js";
import { OwnPrRepairProgressReader } from "../src/services/own-pr-repair-progress-reader.js";
import { GitHubAdapter } from "../src/adapters/github-adapter.js";
import { createWorkflowRouter } from "../src/domain/workflow-router.js";
import { WorkflowRoutingService } from "../src/services/workflow-routing-service.js";
import { WorkLedgerService } from "../src/services/work-ledger-service.js";
import { workflowEventsFromSnapshots } from "../src/domain/workflow-snapshot-events.js";

const REFRESH_STARTED_AT = "2026-08-13T01:02:03.004Z";

function isolatedRefresh({ collect, summarizeDingTalk, auxiliaryTimeoutMs = 15, dingtalkTimeoutMs = auxiliaryTimeoutMs, dingtalkSummaryTimeoutMs = auxiliaryTimeoutMs }) {
  const store = new MemoryStore();
  const service = new RefreshService({
    github: { async searchRelevantPullRequests() { return [pullRequest()]; },
      async searchIssues() { return []; }, async versions() { return []; } },
    dingtalk: { collect }, brain: { summarizeDingTalk }, store, notifier: {},
    auxiliaryTimeoutMs, dingtalkTimeoutMs, dingtalkSummaryTimeoutMs, clock: () => new Date(REFRESH_STARTED_AT),
    config: { trackedRepositories: [], dingtalk: { enabled: true },
      brain: { enabled: true }, prResponsibility: { historicalAfterDays: 60 } },
  });
  return { store, service };
}

function deferredSummaryFixture() {
  let title = "版本发布，请确认风险";
  let finish;
  let summarySignal;
  let calls = 0;
  const fixture = isolatedRefresh({
    dingtalkSummaryTimeoutMs: 1000,
    collect: async () => ({ errors: [], items: [{ id: "message:release", kind: "message", context: "研发群",
      title, updatedAt: REFRESH_STARTED_AT }] }),
    summarizeDingTalk: (groups, { signal }) => {
      calls++; summarySignal = signal;
      return new Promise(resolve => { finish = () => resolve(groups.map(group => ({ groupId: group.groupId,
        important: true, summary: "已核对的版本发布摘要", highlights: [], actionRequired: "确认风险" }))); });
    },
  });
  return { ...fixture, change() { title = "新版本发布，请重新确认"; }, finish() { finish(); },
    get calls() { return calls; }, get signal() { return summarySignal; } };
}

test("deferred summaries do not block facts, and unchanged messages reuse the completed summary", async () => {
  const f = deferredSummaryFixture();
  await f.service.refresh({ deferDingTalkSummary: true });
  assert.equal(f.calls, 0);
  assert.equal((await f.store.read("snapshot")).brain.dingtalkSummaryState, "pending");
  const summary = f.service.summarizePendingDingTalk();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls, 1);
  f.finish(); await summary;
  assert.equal((await f.store.read("snapshot")).items.find(x => x.kind === "message").summaryStatus, "ai");
  await f.service.refresh({ deferDingTalkSummary: true });
  await f.service.summarizePendingDingTalk();
  assert.equal(f.calls, 1, "unchanged messages must not trigger another model call");
});

test("a deferred response cannot overwrite a newer message snapshot", async () => {
  const f = deferredSummaryFixture();
  await f.service.refresh({ deferDingTalkSummary: true });
  const summary = f.service.summarizePendingDingTalk();
  await new Promise(resolve => setImmediate(resolve));
  f.change(); await f.service.refresh({ deferDingTalkSummary: true });
  const before = JSON.stringify(await f.store.read("snapshot"));
  f.finish(); await summary;
  assert.equal(JSON.stringify(await f.store.read("snapshot")), before);
});

test("unchanged facts keep an in-flight summary across refresh timestamps without another model call", async () => {
  const f = deferredSummaryFixture();
  await f.service.refresh({ deferDingTalkSummary: true });
  const summary = f.service.summarizePendingDingTalk();
  await new Promise(resolve => setImmediate(resolve));
  const latestTime = "2026-08-13T01:03:03.004Z";
  f.service.clock = () => new Date(latestTime);
  await f.service.refresh({ deferDingTalkSummary: true });
  const duplicate = f.service.summarizePendingDingTalk();
  f.finish();
  assert.equal((await summary).state, "complete");
  assert.equal((await duplicate).skipped, "no_pending_summary");
  const snapshot = await f.store.read("snapshot");
  assert.equal(snapshot.refreshedAt, latestTime);
  assert.equal(snapshot.brain.dingtalkSummaryState, "complete");
  assert.equal(snapshot.items.find(x => x.kind === "message").summaryStatus, "ai");
  assert.equal(f.calls, 1);
});

test("deferred summaries preserve retained sources and concurrent PR metadata", async () => {
  const f = deferredSummaryFixture();
  await f.store.write("snapshot", { refreshedAt: REFRESH_STARTED_AT, items: [{
    id: "mail:retained", kind: "mail", summaryStatus: "fallback", title: "旧邮箱摘要",
  }] });
  const collect = f.service.dingtalk.collect;
  f.service.dingtalk.collect = async (...args) => ({ ...await collect(...args), errors: ["mail: unavailable"], failedSources: ["mail"] });
  await f.service.refresh({ deferDingTalkSummary: true });
  const summary = f.service.summarizePendingDingTalk();
  await new Promise(resolve => setImmediate(resolve));
  const current = await f.store.read("snapshot");
  current.brain.assessed = 7;
  current.items.find(x => x.kind === "pull_request").headRefOid = "current-head";
  await f.store.write("snapshot", current);
  f.finish(); await summary;
  const next = await f.store.read("snapshot");
  assert.equal(next.items.find(x => x.id === "mail:retained").title, "旧邮箱摘要");
  assert.equal(next.items.find(x => x.kind === "pull_request").headRefOid, "current-head");
  assert.equal(next.brain.assessed, 7);
  assert.equal(next.sourceStatus.dingtalk.stale, true);
});

test("changed summary model invalidates the cache while duplicate workers share one result", async () => {
  const f = deferredSummaryFixture();
  await f.service.refresh({ deferDingTalkSummary: true });
  const first = f.service.summarizePendingDingTalk();
  const duplicate = f.service.summarizePendingDingTalk();
  await new Promise(resolve => setImmediate(resolve));
  f.finish(); await Promise.all([first, duplicate]);
  assert.equal(f.calls, 1);
  f.service.config.brain.model = "changed-model";
  await f.service.refresh({ deferDingTalkSummary: true });
  assert.equal((await f.store.read("snapshot")).brain.dingtalkSummaryState, "pending");
});

test("shutdown cancels deferred summarization without publishing a late result", async () => {
  const f = deferredSummaryFixture();
  await f.service.refresh({ deferDingTalkSummary: true });
  const controller = new AbortController();
  const summary = f.service.summarizePendingDingTalk({ signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  const before = JSON.stringify(await f.store.read("snapshot"));
  const reason = new Error("shutdown"); controller.abort(reason);
  await assert.rejects(summary, error => error === reason);
  assert.equal(f.signal.aborted, true);
  f.finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(await f.store.read("snapshot")), before);
});

test("DingTalk collection can outlive the AI budget and still publish fresh data", async () => {
  const { store, service } = isolatedRefresh({
    auxiliaryTimeoutMs: 10, dingtalkTimeoutMs: 200,
    collect: async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return { errors: [], items: [{ id: "todo:fresh", kind: "todo", title: "fresh task" }] };
    },
  });
  await service.refresh();
  const snapshot = await store.read("snapshot");
  assert.equal(snapshot.sourceStatus.dingtalk.ok, true);
  assert.ok(snapshot.items.some(item => item.id === "todo:fresh"));
});

test("DingTalk starts while GitHub discovery is pending", async () => {
  let collected;
  const collectionStarted = new Promise(resolve => { collected = resolve; });
  const { service } = isolatedRefresh({ collect: async () => {
    collected(); return { items: [], errors: [] };
  } });
  service.github.searchRelevantPullRequests = async () => {
    await collectionStarted; return [pullRequest()];
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("collection did not start alongside GitHub")), 500);
  try { await service.refresh({ signal: controller.signal }); }
  finally { clearTimeout(timer); }
});

test("a stuck message source cannot hold fresh GitHub facts or replace them after its deadline", async () => {
  let finishCollection;
  let collectionSignal;
  const pending = new Promise(resolve => { finishCollection = resolve; });
  const { store, service } = isolatedRefresh({ collect: (_since, { signal }) => {
    collectionSignal = signal;
    return pending;
  } });
  const startedAt = performance.now();
  const refresh = service.refresh();
  const timer = setTimeout(() => finishCollection({ items: [], errors: [] }), 1000);
  try {
    await refresh;
    assert.ok(performance.now() - startedAt < 750, "a pending independent source must not hold refresh");
    assert.equal(collectionSignal.aborted, true, "the independent source is cancelled at its budget");
    const snapshot = await store.read("snapshot");
    assert.equal(snapshot.sourceStatus.githubPullRequests.complete, true);
    assert.equal(snapshot.sourceStatus.dingtalk.stale, true);
    assert.equal(snapshot.items.find(item => item.kind === "pull_request").headRefOid, "head-1");
    const recorded = JSON.stringify(snapshot);
    finishCollection({ items: [{ id: "late", kind: "todo", title: "late result" }], errors: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(await store.read("snapshot")), recorded);
  } finally { clearTimeout(timer); finishCollection({ items: [], errors: [] }); }
});

test("a stuck AI digest falls back to collected messages within its bounded budget", async () => {
  let finishSummary;
  let summarySignal;
  const pending = new Promise(resolve => { finishSummary = resolve; });
  const { store, service } = isolatedRefresh({
    collect: async () => ({ errors: [], items: [{ id: "message:release", kind: "message", context: "研发群",
      title: "版本已发布", author: "测试", updatedAt: REFRESH_STARTED_AT }] }),
    summarizeDingTalk: (_groups, { signal }) => { summarySignal = signal; return pending; },
  });
  const startedAt = performance.now();
  const timer = setTimeout(() => finishSummary([]), 1000);
  try {
    await service.refresh();
    assert.ok(performance.now() - startedAt < 750, "a pending optional summary must not hold refresh");
    assert.equal(summarySignal.aborted, true);
    const snapshot = await store.read("snapshot");
    assert.equal(snapshot.sourceStatus.githubPullRequests.complete, true);
    assert.equal(snapshot.sourceStatus.dingtalk.ok, true);
    assert.equal(snapshot.brain.dingtalkSummaryError.code, "REFRESH_AUXILIARY_TIMEOUT");
    assert.match(snapshot.items.find(item => item.summaryStatus === "fallback").title, /版本已发布/);
    const recorded = JSON.stringify(snapshot);
    finishSummary([{ groupId: "late", summary: "late model response" }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(await store.read("snapshot")), recorded);
  } finally { clearTimeout(timer); finishSummary([]); }
});

test("refresh cancellation aborts a pending auxiliary read and never publishes its fallback", async () => {
  let entered;
  let finishCollection;
  let collectionSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const { store, service } = isolatedRefresh({ collect: (_since, { signal }) => {
    collectionSignal = signal; entered(); return new Promise(resolve => { finishCollection = resolve; });
  }, auxiliaryTimeoutMs: 1000 });
  const controller = new AbortController();
  const refresh = service.refresh({ signal: controller.signal });
  await started;
  const reason = new Error("owner cancelled refresh");
  const cancelledAt = performance.now();
  controller.abort(reason);
  const timer = setTimeout(() => finishCollection({ items: [], errors: [] }), 1000);
  try {
    await assert.rejects(refresh, error => error === reason);
    assert.ok(performance.now() - cancelledAt < 750, "cancellation must not wait for the adapter");
    assert.equal(collectionSignal.aborted, true);
    assert.equal(await store.read("snapshot"), null);
  } finally { clearTimeout(timer); finishCollection({ items: [], errors: [] }); }
});

test("a late PR assessment cannot change authoritative facts after its read budget expires", async () => {
  const store = new MemoryStore();
  let finishAssessment;
  let assessedInput;
  const pending = new Promise(resolve => { finishAssessment = resolve; });
  const service = new RefreshService({
    github: { async searchRelevantPullRequests() { return [pullRequest({ reviewFactsAvailable: false })]; },
      async searchIssues() { return []; }, async versions() { return []; } },
    dingtalk: {}, store, notifier: {}, auxiliaryTimeoutMs: 15,
    brain: { assessPullRequest(item) { assessedInput = item; return pending; } },
    clock: () => new Date(REFRESH_STARTED_AT),
    config: { trackedRepositories: [], dingtalk: { enabled: false }, brain: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 } },
  });
  const timer = setTimeout(() => finishAssessment({ classification: "action_now" }), 1000);
  try {
    await service.refresh();
    const snapshot = await store.read("snapshot");
    assert.equal(snapshot.brain.assessed, 0);
    assert.equal(snapshot.sourceStatus.githubPullRequests.complete, true);
    assert.equal(snapshot.items[0].actionState, "uncertain");
    assessedInput.headRefOid = "late-mutation";
    finishAssessment({ classification: "action_now" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(snapshot.items[0].headRefOid, "head-1");
    assert.equal(snapshot.items[0].brainAssessment, undefined);
  } finally { clearTimeout(timer); finishAssessment({}); }
});

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  async read(name, fallback = null) {
    return this.values.has(name) ? this.values.get(name) : fallback;
  }

  async write(name, value) {
    this.values.set(name, value);
  }
}

function pullRequest(overrides = {}) {
  return {
    id: "github:pr:acme/repo#1",
    kind: "pull_request",
    relation: "review_requested",
    author: "someone-else",
    currentUser: "local-owner",
    assignees: ['local-owner'],
    state: "open",
    updatedAt: "2026-07-31T08:00:00.000Z",
    reviewFactsAvailable: true,
    headRefOid: "head-1",
    myReviewState: "",
    ciStatus: "NONE",
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

test("an incoherent live head fences its PR while new assignments reach durable review roots", async () => {
  const store = new MemoryStore();
  let phase = "baseline";
  let now = "2026-11-06T03:00:00.000Z";
  const clock = () => new Date(now);
  const target = (number) => ({
    number, url: `https://github.com/acme/repo/pull/${number}`, state: "OPEN",
    author: { login: "contributor" }, changedFiles: 1,
    baseRefName: "main", baseRefOid: "d".repeat(40),
    baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: "a".repeat(40) } },
    headRefName: `feature-${number}`, headRefOid: "b".repeat(40),
    headRepository: { nameWithOwner: "acme/repo" },
    headRef: { name: `feature-${number}`, repository: { nameWithOwner: "acme/repo" },
      target: { oid: phase === "incoherent" && number === 8 ? "c".repeat(40) : "b".repeat(40) } },
  });
  const github = new GitHubAdapter({ run: async (_command, args) => {
    if (args.some(value => value.includes("query MyDashboardCurrentPullRequestTargets"))) {
      const query = args.find(value => value.startsWith("query="));
      const aliases = [...query.matchAll(/(r\d+):repository\(owner:"acme",name:"repo"\)\s*\{\s*nameWithOwner pullRequest\(number:(\d+)\)/gu)];
      const response = { data: Object.fromEntries(aliases.map(([, alias, number]) => [alias,
        { nameWithOwner: "acme/repo", pullRequest: target(Number(number)) }])) };
      if (phase === "partial") delete response.data[aliases[0][1]];
      return response;
    }
    if (args[0] === "api") return { login: "runtime-user" };
    if (args[0] === "search") return args.includes("--assignee=@me")
      ? (phase === "baseline" ? [8] : [8, 9, 10, 11, 12]).map(number => ({
        number, title: `Assigned PR ${number}`, url: target(number).url,
        repository: { nameWithOwner: "acme/repo" }, author: { login: "contributor" },
        state: "open", updatedAt: now,
      })) : [];
    if (args[0] === "pr") return { ...target(Number(args[2].split("/").at(-1))),
      headRepository: { name: "repo", nameWithOwner: "acme/repo" }, headRepositoryOwner: { login: "acme" },
      assignees: [{ login: "runtime-user" }], reviews: [], labels: [], statusCheckRollup: [],
      mergeStateStatus: "CLEAN", isDraft: false,
    };
    assert.fail(`Unexpected command: ${args.join(" ")}`);
  } });
  github.searchIssues = async () => [];
  github.versions = async () => [];
  const refresh = new RefreshService({ github, store, clock, dingtalk: {}, brain: null, notifier: {},
    config: { trackedRepositories: [], dingtalk: { enabled: false }, brain: { enabled: false } } });
  const lease = { run: operation => operation() };
  const routing = new WorkflowRoutingService({ store, clock, exclusiveLease: lease, router: createWorkflowRouter() });
  await routing.recover();
  await routing.replaceConfig({ expectedVersion: 0, changedBy: "owner", definition: {
    schemaVersion: 1, enabled: true, maxHops: 8, rules: [{ id: "assigned-review", source: "root", enabled: true,
      priority: 100, fallback: false, condition: { op: "equals", path: "payload.relation", value: "review_requested" },
      targets: [{ type: "role", id: "pr-engineer" }], onMatch: "stop" }],
  } });
  let nextId = 0;
  const ledger = new WorkLedgerService({ store, clock, exclusiveLease: lease, assignmentSource: routing,
    idFactory: () => `discovery-test-${++nextId}` });
  await ledger.recover();
  await refresh.refresh();
  const baseline = structuredClone(await store.read("snapshot"));
  await routing.ingestSnapshot({ snapshot: baseline });
  await ledger.intake();
  const original = (await ledger.listItems()).items.find(item => item.source?.identity.pullRequestNumber === 8);
  assert.ok(original, "the older assignment starts with a durable source root");

  phase = "incoherent"; now = "2026-11-06T03:30:00.000Z";
  await refresh.refresh();
  const current = await store.read("snapshot");
  assert.equal(current.sourceStatus.githubPullRequests.ok, true, "one incoherent head must not reject all assigned PRs");
  assert.equal(current.sourceStatus.githubPullRequests.complete, true, "all search members remain represented");
  const unavailable = current.items.find(item => item.number === 8);
  assert.equal(unavailable.gitTargetAvailable, false);
  assert.equal(unavailable.gitTargetUnavailableReason, "HEAD_REF_CHANGED");
  assert.equal(Object.hasOwn(unavailable, "gitTarget"), false);
  assert.equal(Object.hasOwn(unavailable, "baseRefOid"), false, "historical scalar is never executable authority");
  const events = workflowEventsFromSnapshots(baseline, current);
  assert.ok(events.every(event => event.eventType !== "pull_request.left_scope"));
  const facts = new WorkflowFactSource({ store, clock });
  assert.equal((await facts.read({ item: { event: original.source.current.event }, fact: "state" })).fresh, false);
  await routing.ingestSnapshot({ snapshot: current });
  await ledger.intake();
  const roots = (await ledger.listItems()).items.filter(item => item.kind === "source_root");
  assert.equal(roots.find(item => item.itemId === original.itemId).source.scope.active, true, "unknown target does not retire ownership");
  for (const number of [9, 10, 11, 12]) {
    const root = roots.find(item => item.source?.identity.pullRequestNumber === number);
    assert.ok(root, `new assigned PR ${number} must reach a durable review source root`);
    assert.equal(root.source.identity.targetRoleId, "pr-engineer");
    assert.equal(root.source.current.event.payload.nextAction, "review");
    assert.equal(root.source.current.event.payload.gitTarget.baseRefOid, "a".repeat(40));
    assert.equal(root.source.current.event.payload.gitTarget.headRefOid, "b".repeat(40));
  }
  const candidates = await ledger.listClaimCandidates({ at: now, roleId: "pr-engineer" });
  assert.deepEqual(candidates.items.map(item => item.source.identity.pullRequestNumber).sort((a, b) => a - b),
    [9, 10, 11, 12], "only the four coherent assignments can be claimed");

  phase = "partial"; now = "2026-11-06T03:40:00.000Z";
  await refresh.refresh();
  const retained = await store.read("snapshot");
  assert.equal(retained.sourceStatus.githubPullRequests.complete, false, "truly missing batch members still fail closed");
  assert.equal(retained.sourceStatus.githubPullRequests.stale, true);
  assert.deepEqual(retained.items, current.items, "incomplete source keeps every prior member");
  assert.deepEqual(workflowEventsFromSnapshots(current, retained), [], "incomplete facts cannot emit retirement");
});

test('refresh and retained fallback exclude authored PRs assigned to someone else', async () => {
  const outside = pullRequest({ id: 'reviewer-only', assignmentSource: 'reviewer', assignees: [], reviewRecipient: 'local-owner' });
  const assigned = pullRequest({ id: 'assigned', assignees: ['LOCAL-OWNER'] });
  const authored = pullRequest({ id: 'authored', relation: 'authored', author: 'local-owner', assignees: [] });
  const transferred = pullRequest({ id: 'authored-transferred', relation: 'authored', author: 'local-owner', assignees: ['qa'] });
  const store = new MemoryStore({ snapshot: { refreshedAt: REFRESH_STARTED_AT, items: [outside], versions: [] } }); let fail = false;
  const service = new RefreshService({ github: { async searchRelevantPullRequests() {
    if (fail) throw new Error('GitHub unavailable'); return [outside, assigned, authored, transferred];
  }, async searchIssues() { return []; }, async versions() { return []; } },
    brain: null, dingtalk: {}, store, notifier: {}, clock: () => new Date(REFRESH_STARTED_AT),
    config: { trackedRepositories: [], dingtalk: { enabled: false }, brain: { enabled: false }, prResponsibility: { historicalAfterDays: 60 } } });
  const first = await service.refresh();
  assert.deepEqual(first.diff.removed, [], 'excluded review requests are not reported as completed work');
  assert.deepEqual((await store.read('snapshot')).items.map(item => item.id).sort(), ['assigned', 'authored']);
  const snapshot = await store.read('snapshot'); snapshot.items.push(outside, transferred);
  await store.write('snapshot', snapshot); fail = true;
  await service.refresh();
  const retained = await store.read('snapshot');
  assert.deepEqual(retained.items.map(item => item.id).sort(), ['assigned', 'authored']);
  assert.equal(retained.sourceStatus.githubPullRequests.complete, false);
});

test("an explicitly disabled GitHub read boundary makes no adapter call", async () => {
  let githubCalls = 0;
  const unavailable = async () => {
    githubCalls += 1;
    throw new Error("GitHub must remain unreachable");
  };
  const store = new MemoryStore();
  const service = new RefreshService({
    github: {
      searchRelevantPullRequests: unavailable,
      searchIssues: unavailable,
      versions: unavailable,
    },
    brain: null,
    dingtalk: {},
    store,
    notifier: {},
    config: {
      githubRead: { enabled: false },
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
  });

  await service.refresh();

  assert.equal(githubCalls, 0);
  const snapshot = await store.read("snapshot");
  assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.sources, { github: 0, dingtalk: 0 });
  assert.equal(snapshot.sourceStatus.githubPullRequests.ok, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.stale, false);
  assert.equal(snapshot.sourceStatus.githubPullRequests.enabled, false);
  assert.equal(snapshot.sourceStatus.githubPullRequests.complete, false);
  assert.equal(
    snapshot.sourceStatus.githubPullRequests.effectiveUpdatedWindow.mode,
    "unlimited",
  );
});

test("refresh classifies verified repair publication before building action and waiting groups", async () => {
  const digest = "f".repeat(64), head = "a".repeat(40), repair = "b".repeat(40);
  const pr = pullRequest({ relation: "authored", repo: "acme/repo", number: 1,
    author: "local-owner", headRefOid: head, reviewDecision: "CHANGES_REQUESTED",
    reviewFeedbackAvailable: true, reviewFeedbackCount: 1, reviewFeedbackDigest: digest });
  const store = new MemoryStore({ "automatic-own-pr-repair-state": { schemaVersion: 1, repairs: [],
    published: [{ repository: "acme/repo", number: 1, commitOid: repair, feedbackDigest: digest, confirmationId: "completed-push" }] } });
  const github = { async searchRelevantPullRequests() { return [pr]; }, async searchIssues() { return []; },
    async versions() { return []; }, async isCommitAncestor() { return true; } };
  const service = new RefreshService({ github, dingtalk: {}, store, notifier: {},
    repairProgressReader: new OwnPrRepairProgressReader({ store, github }),
    config: { trackedRepositories: [], dingtalk: { enabled: false }, brain: { enabled: false }, prResponsibility: { historicalAfterDays: 60 } },
    clock: () => "2026-08-01T00:00:00Z" });
  await service.refresh({ notify: false });
  const dashboard = await store.read("dashboard");
  assert.equal(dashboard.groups.actionNow.length, 0);
  assert.equal(dashboard.groups.waitingOther[0].nextActor, "reviewer");
  assert.match(dashboard.groups.waitingOther[0].actionReasons[0], /修复已发布.*当前提交复审/);
  github.searchRelevantPullRequests = async () => { throw new Error("GitHub unavailable"); };
  await service.refresh({ notify: false });
  assert.equal((await store.read("snapshot")).items[0].reviewRepairProgress, undefined);
});

test("notification failure keeps fresh facts while preserving the retry baseline", async () => {
  const previous = { refreshedAt: "2026-08-12T00:00:00.000Z", items: [], versions: [] };
  const baseline = { refreshedAt: "2026-08-11T00:00:00.000Z", items: [], versions: [] };
  const store = new MemoryStore({ snapshot: previous, "notification-snapshot": baseline });
  let attempts = 0;
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return [pullRequest()]; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    dingtalk: { async collect() { return { items: [], errors: [] }; } },
    store,
    notifier: {
      async send() {
        attempts += 1;
        if (attempts === 1) throw new Error("notification timeout");
        return { sent: true, count: 1 };
      },
    },
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date(REFRESH_STARTED_AT),
  });

  const first = await service.refresh({ notify: true });
  assert.equal(first.notification.sent, false);
  assert.match(first.notification.error, /notification timeout/);
  assert.deepEqual(await store.read("notification-snapshot"), baseline);
  assert.deepEqual(await store.read("previous-snapshot"), previous);
  assert.equal((await store.read("snapshot")).items.length, 1);
  assert.equal((await store.read("dashboard")).meta.refreshedAt, REFRESH_STARTED_AT);
  assert.equal((await store.read("last-run")).notification.sent, false);

  const second = await service.refresh({ notify: true });
  assert.equal(second.notification.sent, true);
  assert.equal((await store.read("notification-snapshot")).refreshedAt, REFRESH_STARTED_AT);
  assert.equal(attempts, 2);
});

test("notification baseline advances only for delivery or a known no-send outcome", async () => {
  for (const [reason, shouldAdvance] of [
    ["no-important-change", true],
    ["deferred", false],
  ]) {
    const baseline = { refreshedAt: "2026-08-11T00:00:00.000Z", items: [] };
    const store = new MemoryStore({ "notification-snapshot": baseline });
    const service = new RefreshService({
      github: {
        async searchRelevantPullRequests() { return []; },
        async searchIssues() { return []; },
        async versions() { return []; },
      },
      dingtalk: { async collect() { return { items: [], errors: [] }; } },
      store,
      notifier: { async send() { return { sent: false, reason }; } },
      config: {
        trackedRepositories: [],
        dingtalk: { enabled: true },
        prResponsibility: { historicalAfterDays: 60 },
        brain: { enabled: false },
      },
      clock: () => new Date(REFRESH_STARTED_AT),
    });

    await service.refresh({ notify: true });
    assert.equal(
      (await store.read("notification-snapshot")).refreshedAt,
      shouldAdvance ? REFRESH_STARTED_AT : baseline.refreshedAt,
    );
  }
});

test("refresh cancellation during notification still propagates", async () => {
  const controller = new AbortController();
  const store = new MemoryStore();
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return []; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    dingtalk: { async collect() { return { items: [], errors: [] }; } },
    store,
    notifier: {
      async send() {
        controller.abort(new Error("refresh cancelled"));
        throw controller.signal.reason;
      },
    },
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
  });

  await assert.rejects(service.refresh({ notify: true, signal: controller.signal }), /refresh cancelled/);
  assert.equal(await store.read("notification-snapshot"), null);
});

test("refresh classifies complete PR facts and asks the brain only about uncertain items", async () => {
  const store = new MemoryStore();
  const brainCalls = [];
  const github = {
    async searchRelevantPullRequests() {
      return [
        pullRequest(),
        pullRequest({
          id: "github:pr:acme/repo#2",
          number: 2,
          reviewFactsAvailable: false,
        }),
      ];
    },
    async searchIssues() {
      return [];
    },
    async versions() {
      return [];
    },
  };
  const brain = {
    async assessPullRequest(item) {
      brainCalls.push(item.id);
      return {
        classification: "action_now",
        nextActor: "me",
        confidence: 0.72,
        evidence: ["Assignee 是当前用户"],
        recommendedAction: "确认是否需要首次审核",
        requiresConfirmation: true,
      };
    },
  };
  const service = new RefreshService({
    github,
    brain,
    dingtalk: {},
    store,
    notifier: {},
    clock: () => new Date(REFRESH_STARTED_AT),
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: true, maxAssessmentsPerRefresh: 3 },
    },
  });

  await service.refresh();
  const firstSnapshot = await store.read("snapshot");
  await service.refresh();

  const snapshot = await store.read("snapshot");
  const first = snapshot.items.find((item) => item.id.endsWith("#1"));
  const uncertain = snapshot.items.find((item) => item.id.endsWith("#2"));
  assert.equal(first.actionState, "action_now");
  assert.equal(first.nextAction, "review");
  assert.equal(uncertain.actionState, "uncertain");
  assert.equal(uncertain.brainAssessment.classification, "action_now");
  assert.deepEqual(brainCalls, ["github:pr:acme/repo#2"]);
  assert.equal(firstSnapshot.brain.assessed, 1);
  assert.equal(snapshot.brain.assessed, 0);
  assert.equal(snapshot.sourceStatus.githubPullRequests.ok, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.stale, false);
  assert.equal(snapshot.sourceStatus.githubPullRequests.enabled, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.complete, true);
});

test("an uncertain PR is reassessed when material facts change on the same head", async () => {
  const store = new MemoryStore();
  let refreshCount = 0;
  const brainCalls = [];
  const github = {
    async searchRelevantPullRequests() {
      refreshCount += 1;
      return [
        pullRequest({
          reviewFactsAvailable: false,
          ciStatus: refreshCount === 1 ? "NONE" : "UNKNOWN",
        }),
      ];
    },
    async searchIssues() { return []; },
    async versions() { return []; },
  };
  const service = new RefreshService({
    github,
    brain: {
      async assessPullRequest(item) {
        brainCalls.push(item.ciStatus);
        return {
          classification: "uncertain",
          nextActor: "unknown",
          confidence: 0.5,
          evidence: [item.ciStatus],
          recommendedAction: "请确认",
          requiresConfirmation: true,
        };
      },
    },
    dingtalk: {},
    store,
    notifier: {},
    clock: () => new Date(REFRESH_STARTED_AT),
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: {
        enabled: true,
        provider: "ollama",
        model: "qwen3.5:9b",
        maxAssessmentsPerRefresh: 3,
      },
    },
  });

  await service.refresh();
  await service.refresh();

  assert.deepEqual(brainCalls, ["NONE", "UNKNOWN"]);
});

test("a failed source retains its last known data instead of reporting completion", async () => {
  const previousPullRequest = pullRequest({
    actionState: "action_now",
    nextAction: "review",
  });
  const previousIssue = {
    id: "github:issue:acme/repo#2",
    kind: "issue",
    relation: "assigned",
    title: "Keep me",
    updatedAt: "2026-07-31T08:00:00.000Z",
  };
  const previousMention = {
    id: "dingtalk:mention:3",
    kind: "mention",
    title: "Keep this signal",
    updatedAt: "2026-07-31T08:00:00.000Z",
  };
  const previousVersion = {
    id: "github:release:acme/repo:1",
    type: "release",
    title: "v1",
  };
  const store = new MemoryStore({
    snapshot: {
      refreshedAt: "2026-07-31T08:30:00.000Z",
      items: [previousPullRequest, previousIssue, previousMention],
      versions: [previousVersion],
    },
  });
  const github = {
    async searchRelevantPullRequests() {
      throw new Error("PR source unavailable");
    },
    async searchIssues() {
      throw new Error("Issue source unavailable");
    },
    async versions() {
      throw new Error("Version source unavailable");
    },
  };
  const service = new RefreshService({
    github,
    brain: null,
    dingtalk: {
      async collect() {
        throw new Error("DingTalk unavailable");
      },
    },
    store,
    notifier: {},
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
  });

  await service.refresh();

  const snapshot = await store.read("snapshot");
  assert.deepEqual(
    snapshot.items.map((item) => item.id).sort(),
    [previousPullRequest.id, previousIssue.id, previousMention.id].sort(),
  );
  assert.deepEqual(snapshot.versions, [previousVersion]);
  assert.equal(snapshot.errors.length, 4);
  assert.equal(snapshot.sourceStatus.githubPullRequests.ok, false);
  assert.equal(snapshot.sourceStatus.githubPullRequests.stale, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.enabled, true);
  assert.equal(snapshot.sourceStatus.githubPullRequests.complete, false);
});

test("a failed DingTalk subsource retains only its old items while other sources refresh", async () => {
  const oldMention = {
    id: "dingtalk:mention:old",
    kind: "mention",
    title: "Old mention",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  const oldTodo = {
    id: "dingtalk:todo:old",
    kind: "todo",
    title: "Old todo",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
  const newTodo = { ...oldTodo, id: "dingtalk:todo:new", title: "New todo" };
  const store = new MemoryStore({
    snapshot: {
      refreshedAt: "2026-08-12T01:00:00.000Z",
      items: [oldMention, oldTodo],
      versions: [],
    },
  });
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return []; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    dingtalk: {
      async collect() {
        return {
          items: [newTodo],
          errors: ["mentions: RATE_LIMIT_ERROR"],
          failedSources: ["mentions"],
        };
      },
    },
    store,
    notifier: {},
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
  });
  await service.refresh();
  const snapshot = await store.read("snapshot");
  assert.deepEqual(snapshot.items.map((item) => item.id).sort(), [oldMention.id, newTodo.id].sort());
  assert.equal(snapshot.sourceStatus.dingtalk.stale, true);
});

test("a failed chat source cannot bypass mail grouping or relevance filtering", async () => {
  const store = new MemoryStore();
  let collectedOptions;
  const service = new RefreshService({
    github: { async searchRelevantPullRequests() { return []; }, async searchIssues() { return []; }, async versions() { return []; } },
    dingtalk: { async collect(_since, options) {
      collectedOptions = options;
      return { items: ["first", "second"].map((id) => ({
        id, kind: "mail", title: "订阅通知", content: "无关更新", relation: "followed", conversationId: "mail-thread",
        updatedAt: REFRESH_STARTED_AT,
      })), errors: ["mentions: unavailable"], failedSources: ["mentions"] };
    } },
    brain: { async summarizeDingTalk(groups) {
      assert.equal(groups.length, 1);
      assert.equal(groups[0].messages.length, 1);
      return groups.map((group) => ({ groupId: group.groupId, important: false, summary: "订阅更新", highlights: [], actionRequired: "" }));
    } },
    store, notifier: {}, config: { githubRead: { enabled: false }, trackedRepositories: [],
      dingtalk: { enabled: true, mailEnabled: true }, brain: { enabled: true, provider: "ollama", model: "local" } },
    clock: () => new Date(REFRESH_STARTED_AT),
  });
  await service.refresh();
  assert.equal(collectedOptions.mailEnabled, true);
  assert.deepEqual((await store.read("snapshot")).items, []);
  assert.equal((await store.read("snapshot")).sourceStatus.dingtalk.stale, true);
});

test("refresh freezes one effective PR window and publishes its completeness", async () => {
  const store = new MemoryStore();
  let receivedOptions;
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests(options) {
        receivedOptions = options;
        return [];
      },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {},
    store,
    notifier: {},
    config: {
      githubRead: {
        enabled: true,
        pullRequestUpdatedWindow: { mode: "rolling", days: 7 },
      },
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date(REFRESH_STARTED_AT),
  });

  await service.refresh();

  const effectiveUpdatedWindow = receivedOptions.effectiveUpdatedWindow;
  assert.equal(Object.isFrozen(effectiveUpdatedWindow), true);
  assert.deepEqual(effectiveUpdatedWindow, {
    mode: "rolling",
    days: 7,
    refreshStartedAt: REFRESH_STARTED_AT,
    fromInclusive: "2026-08-06T01:02:03.004Z",
  });
  const snapshot = await store.read("snapshot");
  assert.strictEqual(
    snapshot.sourceStatus.githubPullRequests.effectiveUpdatedWindow,
    effectiveUpdatedWindow,
  );
  assert.equal(snapshot.sourceStatus.githubPullRequests.complete, true);
});

test("failed finite PR discovery remains incomplete without changing its effective window", async () => {
  const store = new MemoryStore();
  let receivedWindow;
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests({ effectiveUpdatedWindow }) {
        receivedWindow = effectiveUpdatedWindow;
        throw new Error("segmented search failed closed");
      },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {},
    store,
    notifier: {},
    config: {
      githubRead: {
        enabled: true,
        pullRequestUpdatedWindow: { mode: "rolling", days: 7 },
      },
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date(REFRESH_STARTED_AT),
  });

  await service.refresh();

  const status = (await store.read("snapshot")).sourceStatus.githubPullRequests;
  assert.equal(status.ok, false);
  assert.equal(status.stale, true);
  assert.equal(status.complete, false);
  assert.strictEqual(status.effectiveUpdatedWindow, receivedWindow);
});

test("a slow refresh cannot renew the freshness age of earlier PR facts", async () => {
  const startedAt = Date.parse("2026-08-02T03:00:00.000Z");
  let now = startedAt;
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: "b".repeat(40),
  };
  const store = new MemoryStore();
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() {
        now = Date.parse("2026-08-02T03:20:00.000Z");
        return [
          pullRequest({
            id: "github:pr:acme/repo#42",
            repo: "acme/repo",
            number: 42,
            currentUser: "runtime-user",
            githubAccount: "runtime-user",
            baseRepository: gitTarget.baseRepository,
            baseRefName: gitTarget.baseRefName,
            baseRefOid: gitTarget.baseRefOid,
            headRepository: gitTarget.headRepository,
            headRefName: gitTarget.headRefName,
            headRefOid: gitTarget.headRefOid,
            gitTargetAvailable: true,
            gitTarget,
            ciStatus: "SUCCESS",
          }),
        ];
      },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {},
    store,
    notifier: {},
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: false },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date(now),
  });

  await service.refresh();
  const snapshot = await store.read("snapshot");
  assert.equal(snapshot.refreshedAt, "2026-08-02T03:00:00.000Z");
  assert.equal(snapshot.durationMs, 20 * 60 * 1_000);

  const facts = new WorkflowFactSource({
    store,
    clock: () => new Date("2026-08-02T03:34:00.000Z"),
  });
  const observed = await facts.read({
    item: {
      event: {
        eventType: "pull_request.updated",
        subject: {
          id: "github:pr:acme/repo#42",
          repository: "acme/repo",
          number: 42,
        },
        payload: {
          headRefOid: gitTarget.headRefOid,
          gitTargetAvailable: true,
          gitTarget,
        },
      },
    },
    fact: "ci-status",
  });
  assert.equal(observed.healthy, true);
  assert.equal(observed.fresh, false);
  assert.equal(observed.value, null);
});

test("refresh publishes grouped DingTalk summaries instead of raw messages or unread conversations", async () => {
  const store = new MemoryStore();
  const summaryCalls = [];
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return []; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: {
      async summarizeDingTalk(groups) {
        summaryCalls.push(groups);
        return groups.map((group) => ({
          groupId: group.groupId,
          important: true,
          summary: "研发群完成版本发布，等待确认风险",
          highlights: ["版本已经发布", "风险尚待确认"],
          actionRequired: "确认发布风险",
        }));
      },
    },
    dingtalk: {
      async collect() {
        return {
          errors: [],
          items: [
            {
              id: "dingtalk:message:1",
              kind: "message",
              title: "版本已经发布",
              author: "张三",
              context: "研发群",
              conversationId: "group-1",
              updatedAt: "2026-08-26T08:00:00.000Z",
            },
            {
              id: "dingtalk:message:2",
              kind: "message",
              title: "[图片消息](mediaId=@secret) 请确认风险",
              author: "李四",
              context: "研发群",
              conversationId: "group-1",
              updatedAt: "2026-08-26T09:00:00.000Z",
            },
            {
              id: "dingtalk:conversation:old",
              kind: "conversation",
              title: "陈年未读会话",
              updatedAt: "2023-01-01T00:00:00.000Z",
            },
          ],
        };
      },
    },
    store,
    notifier: {},
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: true, provider: "ollama", model: "qwen3.5:9b" },
    },
  });

  await service.refresh();

  const snapshot = await store.read("snapshot");
  assert.equal(summaryCalls.length, 1);
  assert.equal(summaryCalls[0].length, 1);
  assert.ok(!JSON.stringify(summaryCalls).includes("mediaId"));
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].title, "研发群完成版本发布，等待确认风险");
  assert.equal(snapshot.items[0].summaryStatus, "ai");
  assert.equal(snapshot.items[0].sourceMessages.length, 2);
  assert.equal(snapshot.brain.dingtalkSummarized, 1);
  assert.equal(snapshot.sources.dingtalk, 1);
});

test("DingTalk summary failure preserves collected messages and shows a readable fallback notice", async () => {
  const store = new MemoryStore();
  const diagnostic = "Invalid Ollama DingTalk digest after retry: missing groupId: opaque-id";
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return [pullRequest()]; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: { async summarizeDingTalk() { throw new Error(diagnostic); } },
    dingtalk: {
      async collect() {
        return { errors: [], items: [{
          id: "message:release", kind: "message", context: "研发群", author: "张三",
          title: "版本已发布，等待测试确认", updatedAt: REFRESH_STARTED_AT,
        }] };
      },
    },
    store, notifier: {},
    config: {
      trackedRepositories: [], dingtalk: { enabled: true },
      brain: { enabled: true, provider: "ollama", model: "qwen3.5:9b" },
    },
  });
  await service.refresh();
  const snapshot = await store.read("snapshot");
  assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.brain.errors, ["钉钉 AI 摘要暂时不可用，已显示消息摘录；系统将自动重试。"]);
  assert.deepEqual(snapshot.brain.dingtalkSummaryError, { message: diagnostic });
  assert.equal(snapshot.brain.dingtalkSummarized, 0);
  assert.equal(snapshot.sourceStatus.dingtalk.ok, true);
  const digest = snapshot.items.find(({ summaryStatus }) => summaryStatus === "fallback");
  assert.match(digest.title, /版本已发布/);
  assert.equal(digest.sourceMessages[0].content, "版本已发布，等待测试确认");
  assert.equal(snapshot.items.some(({ kind }) => kind === "pull_request"), true);
});

test("a scheduled DingTalk report is durably claimed and sent once per slot", async () => {
  const store = new MemoryStore();
  const reports = [];
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return []; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {
      async collect() {
        return {
          errors: [],
          items: [{
            id: "dingtalk:todo:daily-report",
            kind: "todo",
            relation: "assigned",
            title: "提交日报",
            updatedAt: "2026-09-23T00:30:00.000Z",
            state: "open",
          }],
        };
      },
    },
    store,
    notifier: {
      async sendReport(report) { reports.push(report); },
    },
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date("2026-09-23T01:05:00.000Z"),
  });

  await service.refresh();
  await service.refresh();

  assert.equal(reports.length, 1);
  assert.equal(reports[0].slotKey, "2026-09-23@09:00");
  const state = await store.read("dingtalk-report-state");
  assert.equal(state.lastSlotKey, "2026-09-23@09:00");
  assert.equal(state.latest.status, "sent");
  const dashboard = await store.read("dashboard");
  assert.equal(dashboard.dingtalkReport.status, "sent");
  assert.equal(dashboard.dingtalkReport.counts.todos, 1);
});

test("an uncertain DingTalk report failure is not retried in the same slot", async () => {
  const store = new MemoryStore();
  let attempts = 0;
  const service = new RefreshService({
    github: {
      async searchRelevantPullRequests() { return []; },
      async searchIssues() { return []; },
      async versions() { return []; },
    },
    brain: null,
    dingtalk: {
      async collect() { return { errors: [], items: [] }; },
    },
    store,
    notifier: {
      async sendReport() {
        attempts += 1;
        throw new Error("transport outcome unknown");
      },
    },
    config: {
      trackedRepositories: [],
      dingtalk: { enabled: true },
      prResponsibility: { historicalAfterDays: 60 },
      brain: { enabled: false },
    },
    clock: () => new Date("2026-09-23T04:05:00.000Z"),
  });

  await service.refresh();
  await service.refresh();

  assert.equal(attempts, 1);
  const state = await store.read("dingtalk-report-state");
  assert.equal(state.lastSlotKey, "2026-09-23@12:00");
  assert.equal(state.latest.status, "failed");
  assert.match(
    (await store.read("dashboard")).dingtalkReport.error,
    /不会自动重发/,
  );
});
