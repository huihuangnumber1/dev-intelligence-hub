import assert from "node:assert/strict";
import test from "node:test";
import { RefreshService } from "../src/services/refresh-service.js";

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

function uncertainPullRequest(overrides = {}) {
  return {
    id: "github:pr:acme/repo#7",
    kind: "pull_request",
    repo: "acme/repo",
    number: 7,
    relation: "review_requested",
    author: "someone-else",
    currentUser: "me",
    assignees: ['me'],
    state: "open",
    updatedAt: new Date().toISOString(),
    reviewFactsAvailable: false,
    headRefOid: "head-1",
    ciStatus: "NONE",
    mergeStateStatus: "CLEAN",
    ...overrides,
  };
}

function config() {
  return {
    trackedRepositories: [],
    dingtalk: { enabled: false },
    prResponsibility: { historicalAfterDays: 60 },
    brain: { enabled: true, maxAssessmentsPerRefresh: 3 },
  };
}

function service({ store, pullRequests = [], brainCalls = [] }) {
  return new RefreshService({
    github: {
      async searchRelevantPullRequests() {
        return pullRequests;
      },
      async searchIssues() {
        return [];
      },
      async versions() {
        return [];
      },
    },
    brain: {
      async assessPullRequest(item) {
        brainCalls.push(item.id);
        return {
          classification: "waiting_other",
          confidence: 0.6,
          recommendedAction: "请人工确认",
        };
      },
    },
    dingtalk: {},
    store,
    notifier: {},
    config: config(),
  });
}

test("refresh applies a matching confirmation before brain assessment", async () => {
  const item = uncertainPullRequest();
  const suggestion = {
    classification: "waiting_other",
    confidence: 0.73,
    recommendedAction: "可能正在等作者",
  };
  const store = new MemoryStore({
    snapshot: {
      refreshedAt: new Date().toISOString(),
      items: [{ ...item, actionState: "uncertain", brainAssessment: suggestion }],
    },
    "pr-responsibility-overrides": {
      [item.id]: {
        id: item.id,
        headRefOid: item.headRefOid,
        actionState: "action_now",
        confirmedAt: "2026-07-31T09:00:00.000Z",
      },
    },
  });
  const brainCalls = [];

  await service({ store, pullRequests: [item], brainCalls }).refresh();

  const refreshed = (await store.read("snapshot")).items[0];
  assert.equal(refreshed.actionState, "action_now");
  assert.equal(refreshed.nextActor, "me");
  assert.equal(refreshed.requiresConfirmation, false);
  assert.match(refreshed.actionReasons[0], /已确认/);
  assert.deepEqual(refreshed.brainAssessment, suggestion);
  assert.deepEqual(brainCalls, []);
});

test("a new head invalidates the saved confirmation and asks the brain again", async () => {
  const item = uncertainPullRequest({ headRefOid: "head-2" });
  const store = new MemoryStore({
    "pr-responsibility-overrides": {
      [item.id]: {
        id: item.id,
        headRefOid: "head-1",
        actionState: "historical",
        confirmedAt: "2026-07-31T09:00:00.000Z",
      },
    },
  });
  const brainCalls = [];

  await service({ store, pullRequests: [item], brainCalls }).refresh();

  const refreshed = (await store.read("snapshot")).items[0];
  assert.equal(refreshed.actionState, "uncertain");
  assert.equal(refreshed.requiresConfirmation, true);
  assert.equal(refreshed.brainAssessment.classification, "waiting_other");
  assert.deepEqual(brainCalls, [item.id]);
});

test("confirm updates local state without refreshing GitHub and keeps the brain suggestion", async () => {
  const suggestion = {
    classification: "action_now",
    confidence: 0.81,
    recommendedAction: "建议现在审核",
  };
  const item = {
    ...uncertainPullRequest(),
    actionState: "uncertain",
    nextActor: "unknown",
    nextAction: "confirm",
    actionReasons: ["审核事实不完整"],
    requiresConfirmation: true,
    brainAssessment: suggestion,
  };
  const store = new MemoryStore({
    snapshot: {
      refreshedAt: "2026-07-31T10:00:00.000Z",
      durationMs: 10,
      sources: { github: 1, dingtalk: 0 },
      errors: [],
      brain: { enabled: true, assessed: 1, errors: [] },
      items: [item],
      versions: [],
    },
  });
  const refreshService = service({ store });

  const dashboard = await refreshService.confirmPullRequestResponsibility(
    item.id,
    "waiting_other",
    item.headRefOid,
  );

  const snapshot = await store.read("snapshot");
  const confirmed = snapshot.items[0];
  const overrides = await store.read("pr-responsibility-overrides");
  assert.equal(confirmed.actionState, "waiting_other");
  assert.equal(confirmed.nextActor, "other");
  assert.equal(confirmed.requiresConfirmation, false);
  assert.deepEqual(confirmed.brainAssessment, suggestion);
  assert.equal(overrides[item.id].headRefOid, "head-1");
  assert.equal(overrides[item.id].actionState, "waiting_other");
  assert.equal(dashboard.groups.waitingOther[0].id, item.id);
  assert.deepEqual(await store.read("dashboard"), dashboard);
});

test("confirm rejects invalid choices, missing items, and already classified PRs", async () => {
  const uncertain = {
    ...uncertainPullRequest(),
    actionState: "uncertain",
    requiresConfirmation: true,
  };
  const classified = {
    ...uncertainPullRequest({ id: "github:pr:acme/repo#8", number: 8 }),
    actionState: "action_now",
    requiresConfirmation: false,
  };
  const store = new MemoryStore({
    snapshot: {
      refreshedAt: new Date().toISOString(),
      items: [uncertain, classified],
      versions: [],
    },
  });
  const refreshService = service({ store });

  await assert.rejects(
    refreshService.confirmPullRequestResponsibility(
      uncertain.id,
      "uncertain",
      uncertain.headRefOid,
    ),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    refreshService.confirmPullRequestResponsibility(
      "missing",
      "action_now",
      "head-1",
    ),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    refreshService.confirmPullRequestResponsibility(
      classified.id,
      "historical",
      classified.headRefOid,
    ),
    (error) => error.statusCode === 409,
  );
});

test("confirmation rejects a decision made for an older head", async () => {
  const item = {
    ...uncertainPullRequest({ headRefOid: "head-2" }),
    actionState: "uncertain",
    requiresConfirmation: true,
  };
  const store = new MemoryStore({
    snapshot: {
      refreshedAt: new Date().toISOString(),
      items: [item],
      versions: [],
    },
  });
  const refreshService = service({ store });

  await assert.rejects(
    refreshService.confirmPullRequestResponsibility(
      item.id,
      "action_now",
      "head-1",
    ),
    (error) => error.statusCode === 409,
  );
  assert.equal(
    await store.read("pr-responsibility-overrides"),
    null,
  );
});

test("concurrent confirmations serialize without losing either override", async () => {
  const first = {
    ...uncertainPullRequest(),
    actionState: "uncertain",
    requiresConfirmation: true,
  };
  const second = {
    ...uncertainPullRequest({
      id: "github:pr:acme/repo#8",
      number: 8,
      headRefOid: "head-8",
    }),
    actionState: "uncertain",
    requiresConfirmation: true,
  };
  const store = new MemoryStore({
    snapshot: {
      refreshedAt: new Date().toISOString(),
      durationMs: 1,
      sources: { github: 2, dingtalk: 0 },
      errors: [],
      items: [first, second],
      versions: [],
    },
  });
  const refreshService = service({ store });

  await Promise.all([
    refreshService.confirmPullRequestResponsibility(
      first.id,
      "action_now",
      first.headRefOid,
    ),
    refreshService.confirmPullRequestResponsibility(
      second.id,
      "waiting_other",
      second.headRefOid,
    ),
  ]);

  const overrides = await store.read("pr-responsibility-overrides");
  const snapshot = await store.read("snapshot");
  assert.deepEqual(Object.keys(overrides).sort(), [first.id, second.id].sort());
  assert.equal(
    snapshot.items.find((item) => item.id === first.id).actionState,
    "action_now",
  );
  assert.equal(
    snapshot.items.find((item) => item.id === second.id).actionState,
    "waiting_other",
  );
});
