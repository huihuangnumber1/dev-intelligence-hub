import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboard } from "../src/domain/dashboard-model.js";

test('personal work excludes reviewer-only and reassigned PRs from every current dashboard group', () => {
  const pr = (id, overrides) => ({ id, kind: 'pull_request', relation: 'review_requested', actionState: 'action_now',
    currentUser: 'reviewer', author: 'contributor', assignees: [], updatedAt: '2026-07-30T09:00:00.000Z', ...overrides });
  const dashboard = buildDashboard({ refreshedAt: '2026-07-30T09:00:00.000Z', versions: [],
    items: [pr('assigned', { assignees: ['REVIEWER'] }), pr('authored', { relation: 'authored', author: 'Reviewer', assignees: [] }),
      pr('authored-transferred', { relation: 'authored', author: 'Reviewer', assignees: ['qa'] }),
      pr('reviewer-only', { assignmentSource: 'reviewer', reviewRecipient: 'reviewer' }),
      pr('reassigned', { assignmentSource: 'assignee', assignees: ['other-user'] }),
      pr('missing-account', { currentUser: undefined }),
      { id: 'issue', kind: 'issue', relation: 'assigned', updatedAt: '2026-07-30T09:00:00.000Z' }] },
    { items: [pr('excluded-history', { assignmentSource: 'reviewer' })] });
  assert.equal(dashboard.counts.total, 3);
  assert.deepEqual(dashboard.groups.actionNow.map(item => item.id).sort(), ['assigned', 'authored']);
  assert.equal(JSON.stringify(dashboard).includes('reviewer-only'), false);
  assert.equal(JSON.stringify(dashboard).includes('reassigned'), false);
  assert.equal(JSON.stringify(dashboard).includes('authored-transferred'), false);
  assert.equal(dashboard.groups.recentlyCompleted.length, 0);
  assert.equal(dashboard.groups.myIssues.length, 1);
});

test('leaving personal scope is not proof that an open PR completed', () => {
  const pr = (id, state) => ({ id, kind: 'pull_request', currentUser: 'reviewer', author: 'contributor',
    assignees: ['reviewer'], state, updatedAt: '2026-07-30T09:00:00.000Z' });
  const dashboard = buildDashboard({ refreshedAt: '2026-07-31T09:00:00.000Z', items: [], versions: [] },
    { items: [pr('transferred-open', 'open'), pr('known-closed', 'closed'), pr('unknown-terminal-state', undefined)] });
  assert.deepEqual(dashboard.groups.recentlyCompleted.map(item => item.id), ['known-closed']);
});

test("focus is capped and grouped by personal responsibility", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    id: `pr-${index}`,
    kind: "pull_request",
    relation: "review_requested",
    currentUser: 'reviewer', author: 'contributor', assignees: ['reviewer'],
    title: `PR ${index}`,
    updatedAt: `2026-07-${String(30 - index).padStart(2, "0")}T09:00:00.000Z`,
  }));
  const dashboard = buildDashboard({
    refreshedAt: "2026-07-30T09:00:00.000Z",
    durationMs: 10,
    sources: { github: 10, dingtalk: 0 },
    errors: [],
    items,
    versions: [],
  });
  assert.equal(dashboard.focus.length, 7);
  assert.equal(dashboard.groups.reviewRequested.length, 10);
  assert.equal(dashboard.counts.reviewRequested, 10);
});

test("dashboard separates PRs by next actor and exposes brain health", () => {
  const pullRequest = (id, actionState) => ({
    id,
    kind: "pull_request",
    relation: "review_requested",
    currentUser: 'reviewer', author: 'contributor', assignees: ['reviewer'],
    actionState,
    nextAction: actionState === "action_now" ? "review" : "wait_review",
    actionReasons: [`${actionState} reason`],
    updatedAt: "2026-07-30T09:00:00.000Z",
  });
  const dashboard = buildDashboard({
    refreshedAt: "2026-07-30T09:00:00.000Z",
    durationMs: 10,
    sources: { github: 4, dingtalk: 0 },
    errors: [],
    brain: {
      enabled: true,
      provider: "ollama",
      model: "qwen3.5:9b",
      assessed: 1,
      errors: [],
    },
    items: [
      pullRequest("now", "action_now"),
      pullRequest("waiting", "waiting_other"),
      pullRequest("history", "historical"),
      pullRequest("confirm", "uncertain"),
    ],
    versions: [],
  });

  assert.deepEqual(dashboard.groups.actionNow.map((item) => item.id), ["now"]);
  assert.deepEqual(
    dashboard.groups.waitingOther.map((item) => item.id),
    ["waiting"],
  );
  assert.deepEqual(
    dashboard.groups.historicalPullRequests.map((item) => item.id),
    ["history"],
  );
  assert.deepEqual(
    dashboard.groups.uncertainPullRequests.map((item) => item.id),
    ["confirm"],
  );
  assert.equal(dashboard.counts.actionNow, 1);
  assert.equal(dashboard.counts.waitingOther, 1);
  assert.equal(dashboard.counts.historicalPullRequests, 1);
  assert.equal(dashboard.counts.uncertainPullRequests, 1);
  assert.equal(dashboard.focus.some((item) => item.id === "waiting"), false);
  assert.equal(dashboard.meta.brain.model, "qwen3.5:9b");
});

test("tracked versions put the most recently published or active record first", () => {
  const dashboard = buildDashboard({
    refreshedAt: "2026-07-31T09:00:00.000Z",
    durationMs: 10,
    sources: { github: 0, dingtalk: 0 },
    errors: [],
    items: [],
    versions: [
      {
        id: "old-milestone",
        type: "milestone",
        title: "Old milestone",
        createdAt: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "new-release",
        type: "release",
        title: "New release",
        publishedAt: "2026-07-30T00:00:00.000Z",
      },
      {
        id: "middle-milestone",
        type: "milestone",
        title: "Middle milestone",
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-07-31T00:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(
    dashboard.groups.versions.map((version) => version.id),
    ["middle-milestone", "new-release", "old-milestone"],
  );
});

test("assigned issues are shown newest first and old items are visibly deferred", () => {
  const dashboard = buildDashboard({
    refreshedAt: "2026-08-26T09:00:00.000Z",
    durationMs: 10,
    sources: { github: 2, dingtalk: 0 },
    errors: [],
    items: [
      {
        id: "stale-issue",
        kind: "issue",
        relation: "assigned",
        updatedAt: "2026-08-01T09:00:00.000Z",
      },
      {
        id: "latest-issue",
        kind: "issue",
        relation: "assigned",
        updatedAt: "2026-08-25T09:00:00.000Z",
      },
    ],
    versions: [],
  });

  assert.deepEqual(
    dashboard.groups.myIssues.map((issue) => issue.id),
    ["latest-issue", "stale-issue"],
  );
  assert.equal(dashboard.groups.myIssues[1].score, 15);
  assert.deepEqual(
    dashboard.groups.myIssues[1].reasons,
    ["超过 14 天，稍后处理"],
  );
  assert.equal(dashboard.groups.myIssues[0].automaticWorkEligible, true);
  assert.equal(dashboard.groups.myIssues[0].manualAddRecommended, false);
  assert.equal(dashboard.groups.myIssues[1].automaticWorkEligible, false);
  assert.equal(dashboard.groups.myIssues[1].manualAddRecommended, true);
});

test("dashboard marks historical PRs and the exact issue cutoff for manual opt-in", () => {
  const dashboard = buildDashboard({
    refreshedAt: "2026-08-31T09:00:00.000Z",
    durationMs: 10,
    sources: { github: 3, dingtalk: 0 },
    errors: [],
    items: [
      {
        id: "historical-pr",
        kind: "pull_request",
        currentUser: 'reviewer', author: 'reviewer', assignees: [],
        repo: "acme/repo",
        number: 1,
        actionState: "historical",
        updatedAt: "2026-08-01T09:00:00.000Z",
      },
      {
        id: "cutoff-issue",
        kind: "issue",
        repo: "acme/repo",
        number: 2,
        relation: "assigned",
        updatedAt: "2026-08-17T09:00:00.000Z",
      },
      {
        id: "recent-issue",
        kind: "issue",
        repo: "acme/repo",
        number: 3,
        relation: "assigned",
        updatedAt: "2026-08-17T09:00:00.001Z",
      },
    ],
    versions: [],
  }, null, { issueActiveWindowDays: 14 });

  assert.equal(
    dashboard.groups.historicalPullRequests[0].automaticWorkEligible,
    false,
  );
  assert.equal(dashboard.groups.historicalPullRequests[0].manualAddRecommended, true);
  assert.equal(dashboard.groups.myIssues[0].automaticWorkEligible, true);
  assert.equal(dashboard.groups.myIssues[1].automaticWorkEligible, false);
});
