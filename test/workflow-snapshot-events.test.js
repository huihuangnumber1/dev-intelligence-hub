import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStoredWorkflowEvent } from "../src/domain/workflow-events.js";
import {
  projectWorkflowSnapshot,
  workflowEventsFromSnapshots,
} from "../src/domain/workflow-snapshot-events.js";

const REFRESHED_AT = "2026-08-02T02:00:00.000Z";

function pullRequest(number, overrides = {}) {
  return {
    id: `github:pr:acme/repo#${number}`,
    kind: "pull_request",
    repo: "acme/repo",
    number,
    title: `PR ${number}`,
    author: "alice",
    relation: "review_requested",
    state: "open",
    createdAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-01T02:00:00.000Z",
    labels: ["backend"],
    assignees: ["local-owner"],
    isDraft: false,
    actionState: "action_now",
    nextActor: "me",
    nextAction: "review",
    requiresConfirmation: false,
    reviewDecision: "",
    ciStatus: "SUCCESS",
    mergeStateStatus: "CLEAN",
    headRefOid: `head-${number}`,
    myReviewState: "",
    ...overrides,
  };
}

function issue(number, overrides = {}) {
  return {
    id: `github:issue:acme/repo#${number}`,
    kind: "issue",
    repo: "acme/repo",
    number,
    title: `Issue ${number}`,
    author: "bob",
    relation: "assigned",
    state: "open",
    createdAt: "2026-08-01T03:00:00.000Z",
    updatedAt: "2026-08-01T04:00:00.000Z",
    description: "Issue body with reproduction steps and an attachment URL",
    labels: ["bug"],
    assignees: ["local-owner"],
    commentsCount: 1,
    latestComment: {
      author: "carol",
      body: "Use the release branch when implementing the fix",
      createdAt: "2026-08-01T04:00:00.000Z",
      updatedAt: "2026-08-01T04:00:00.000Z",
      url: `https://github.com/acme/repo/issues/${number}#issuecomment-1`,
    },
    ...overrides,
  };
}

function snapshot(items, overrides = {}) {
  return {
    refreshedAt: REFRESHED_AT,
    sourceStatus: {
      githubPullRequests: { ok: true, stale: false },
      githubIssues: { ok: true, stale: false },
    },
    items,
    ...overrides,
  };
}

function eventTypes(events) {
  return events.map((event) => `${event.subject.id}:${event.eventType}`);
}

test("incoming review receipt facts survive snapshot routing and stored event validation", () => {
  const receipt = {
    incomingReviewFactsAvailable: true,
    reviewRecipient: "local-owner",
    reviewReceivedAt: "2026-08-02T01:30:00Z",
    reviewReceivedFrom: "alice",
    reviewReceivedVia: "assignee",
    reviewRequestEventId: "AE_node_1",
    myLatestPublishedReviewAt: "2026-08-01T09:30:00Z",
  };
  const events = workflowEventsFromSnapshots(snapshot([pullRequest(1)]), snapshot([pullRequest(1, receipt)]));
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.deepEqual(normalizeStoredWorkflowEvent(event), event);
    for (const [key, value] of Object.entries(receipt)) assert.equal(event.payload[key], value);
  }
  assert.throws(() => workflowEventsFromSnapshots(snapshot([]), snapshot([pullRequest(1, { ...receipt, incomingReviewFactsAvailable: "true" })])), /payload.incomingReviewFactsAvailable/);
});

test("new own PR feedback on the same head survives routing as a distinct source update", () => {
  const facts = { relation: "authored", nextAction: "address_review", reviewFeedbackAvailable: true, reviewFeedbackCount: 1, reviewFeedbackDigest: "a".repeat(64), reviewFeedbackAt: "2026-08-02T01:30:00Z", reviewFeedbackIds: ["thread:1"] };
  const previous = snapshot([pullRequest(1, facts)]);
  const changed = snapshot([pullRequest(1, { ...facts, reviewFeedbackDigest: "b".repeat(64), reviewFeedbackIds: ["thread:1", "thread:2"], reviewFeedbackCount: 2 })]);
  const events = workflowEventsFromSnapshots(previous, changed);
  assert.ok(events.length > 0);
  assert.ok(events.some(({ payload }) => payload.changedFields.includes("reviewFeedbackDigest")));
  assert.ok(events.every(({ payload }) => payload.headRefOid === "head-1" && payload.reviewFeedbackDigest === "b".repeat(64)));
  for (const event of events) assert.deepEqual(normalizeStoredWorkflowEvent(event), event);
  assert.deepEqual(workflowEventsFromSnapshots(changed, changed), []);
  const large = workflowEventsFromSnapshots(null, snapshot([pullRequest(1, { ...facts, reviewFeedbackCount: 1_250, reviewFeedbackIds: Array.from({ length: 1_250 }, (_, index) => `thread:${index}`) })]));
  assert.equal(large[0].payload.reviewFeedbackCount, 1_250);
  assert.equal(Object.hasOwn(large[0].payload, "reviewFeedbackIds"), false);
});

test("snapshot projection is a deterministic safe replay checkpoint", () => {
  const input = snapshot(
    [
      issue(3, { labels: ["triage", "bug", "bug"] }),
      { id: "dingtalk:todo:1", kind: "todo", title: "ignore me" },
      pullRequest(1, {
        labels: ["risk:high", "backend"],
        token: "must-not-persist",
        env: { GH_TOKEN: "must-not-persist" },
        command: "gh pr review",
      }),
    ],
    {
      sourceStatus: {
        githubPullRequests: { ok: true, stale: false, detail: "drop" },
        githubIssues: { ok: false, stale: true, error: "drop" },
        dingtalk: { ok: true, stale: false },
      },
      errors: ["drop"],
    },
  );

  const projected = projectWorkflowSnapshot(input);
  const reordered = projectWorkflowSnapshot({
    ...input,
    items: [...input.items].reverse(),
  });

  assert.deepEqual(Object.keys(projected), [
    "refreshedAt",
    "sourceStatus",
    "items",
  ]);
  assert.deepEqual(projected.sourceStatus, {
    githubPullRequests: { ok: true, stale: false },
    githubIssues: { ok: false, stale: true },
  });
  assert.deepEqual(
    projected.items.map(({ id }) => id),
    ["github:pr:acme/repo#1", "github:issue:acme/repo#3"],
  );
  assert.deepEqual(projected.items[0].labels, ["backend", "risk:high"]);
  assert.deepEqual(projected.items[1].labels, ["bug", "triage"]);
  assert.deepEqual(reordered, projected);
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), projected);
  assert.equal(JSON.stringify(projected).includes("must-not-persist"), false);
  assert.ok(Object.isFrozen(projected));
  assert.ok(projected.items.every(Object.isFrozen));
});

test("an initial healthy snapshot emits stable observed events with safe facts", () => {
  const unsafe = pullRequest(2, {
    description: "PR body must stay in the dedicated PR context reader",
    token: "secret-token",
    env: { GH_TOKEN: "secret-token" },
    command: "gh pr merge",
  });
  const current = snapshot([
    issue(3),
    { id: "dingtalk:todo:1", kind: "todo" },
    unsafe,
    pullRequest(1),
  ]);

  const events = workflowEventsFromSnapshots(null, current);

  assert.deepEqual(eventTypes(events), [
    "github:pr:acme/repo#1:pull_request.observed",
    "github:pr:acme/repo#2:pull_request.observed",
    "github:issue:acme/repo#3:issue.observed",
  ]);
  assert.ok(events.every((event) => event.occurredAt === REFRESHED_AT));
  assert.ok(
    events.every(
      (event) =>
        event.source.provider === "github" &&
        event.source.scopeId === "github-dashboard",
    ),
  );
  assert.deepEqual(events[0].subject, {
    id: "github:pr:acme/repo#1",
    repository: "acme/repo",
    number: 1,
  });
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes('"env"'), false);
  assert.equal(serialized.includes('"command"'), false);
  assert.equal(serialized.includes("PR body must stay"), false);
  const issueEvent = events.find(
    ({ eventType }) => eventType === "issue.observed",
  );
  assert.equal(issueEvent.payload.commentsCount, 1);
  assert.match(issueEvent.payload.evidenceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(serialized.includes("Issue body with reproduction steps"), false);
  assert.equal(serialized.includes("Use the release branch"), false);
  assert.ok(events.every(Object.isFrozen));
});

test("historical pull requests leave employee workflow scope but remain dashboard facts", () => {
  const active = snapshot([pullRequest(1)]);
  const historical = snapshot([
    pullRequest(1, {
      actionState: "historical",
      nextActor: "none",
      nextAction: "cleanup",
      inactiveDays: 30,
    }),
  ]);

  assert.deepEqual(projectWorkflowSnapshot(historical).items, []);
  assert.deepEqual(eventTypes(workflowEventsFromSnapshots(active, historical)), [
    "github:pr:acme/repo#1:pull_request.left_scope",
  ]);
});

test("issues outside the active window stay in dashboard facts but never enter a new workflow", () => {
  const old = issue(20, { updatedAt: "2026-07-01T02:00:00.000Z" });
  const exactlyAtCutoff = issue(21, {
    updatedAt: "2026-07-19T02:00:00.000Z",
  });
  const recent = issue(22, { updatedAt: "2026-07-19T02:00:00.001Z" });
  const current = snapshot([old, exactlyAtCutoff, recent]);

  const checkpoint = projectWorkflowSnapshot(current, {
    issueActiveWindowDays: 14,
  });
  const events = workflowEventsFromSnapshots(null, current, {
    issueActiveWindowDays: 14,
  });

  assert.deepEqual(checkpoint.items.map(({ id }) => id), [recent.id]);
  assert.deepEqual(eventTypes(events), [
    `${recent.id}:issue.observed`,
  ]);
  assert.deepEqual(current.items.map(({ id }) => id), [
    old.id,
    exactlyAtCutoff.id,
    recent.id,
  ]);
});

test("an issue emits one left-scope event when it naturally ages out", () => {
  const item = issue(23, { updatedAt: "2026-08-01T04:00:00.000Z" });
  const previous = snapshot([item]);
  const current = snapshot([item], {
    refreshedAt: "2026-08-16T04:00:00.000Z",
  });

  const events = workflowEventsFromSnapshots(previous, current, {
    issueActiveWindowDays: 14,
  });

  assert.deepEqual(eventTypes(events), [
    `${item.id}:issue.left_scope`,
  ]);
});

test("an unhealthy issue source cannot synthesize age-based left-scope events", () => {
  const item = issue(24, { updatedAt: "2026-08-01T04:00:00.000Z" });
  const previous = snapshot([item]);
  const current = snapshot([item], {
    refreshedAt: "2026-08-16T04:00:00.000Z",
    sourceStatus: {
      githubPullRequests: { ok: true, stale: false },
      githubIssues: { ok: false, stale: true },
    },
  });

  assert.deepEqual(
    workflowEventsFromSnapshots(previous, current, {
      issueActiveWindowDays: 14,
    }),
    [],
  );
});

test("additions and material changes emit granular events without flooding unchanged items", () => {
  const previous = snapshot([
    pullRequest(1),
    pullRequest(4),
    issue(10),
  ], { refreshedAt: "2026-08-02T01:00:00.000Z" });
  const current = snapshot([
    issue(10),
    issue(11),
    pullRequest(1, {
      title: "Merged PR 1",
      labels: ["backend", "risk:high"],
      state: "merged",
      ciStatus: "PENDING",
      updatedAt: "2026-08-02T01:59:00.000Z",
    }),
  ]);

  const events = workflowEventsFromSnapshots(previous, current, {
    sourceScopeId: "local-owner",
  });

  assert.deepEqual(eventTypes(events), [
    "github:pr:acme/repo#1:pull_request.updated",
    "github:pr:acme/repo#1:pull_request.classified",
    "github:pr:acme/repo#1:pull_request.status",
    "github:pr:acme/repo#1:pull_request.completed",
    "github:pr:acme/repo#4:pull_request.left_scope",
    "github:issue:acme/repo#11:issue.created",
  ]);
  assert.equal(events.every((event) => event.source.scopeId === "local-owner"), true);

  const changed = events.filter((event) => event.subject.number === 1);
  assert.deepEqual(changed[0].payload.changedFields, [
    "title",
    "updatedAt",
    "labels",
    "state",
    "ciStatus",
  ]);
  assert.deepEqual(changed[1].payload.changedFields, ["labels"]);
  assert.deepEqual(changed[2].payload.changedFields, ["state", "ciStatus"]);
  assert.equal(changed[3].payload.previousState, "open");
  assert.equal(changed[3].payload.state, "merged");
  assert.equal(
    events.some((event) => event.subject.id === "github:issue:acme/repo#10"),
    false,
  );
});

test("a changed PR Head carries its causal predecessor on the update event", () => {
  const previous = snapshot([
    pullRequest(1, { headRefOid: "head-a" }),
  ], { refreshedAt: "2026-08-02T01:00:00.000Z" });
  const current = snapshot([
    pullRequest(1, { headRefOid: "head-b" }),
  ]);

  const events = workflowEventsFromSnapshots(previous, current);

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "pull_request.updated");
  assert.equal(events[0].payload.headRefOid, "head-b");
  assert.equal(events[0].payload.previousHeadRefOid, "head-a");
  assert.deepEqual(events[0].payload.changedFields, ["headRefOid"]);
});

test("newly available issue evidence emits an update for existing work", () => {
  const previous = snapshot([
    issue(12, {
      description: undefined,
      commentsCount: undefined,
      latestComment: undefined,
    }),
  ], { refreshedAt: "2026-08-02T01:00:00.000Z" });
  const current = snapshot([issue(12)]);

  const events = workflowEventsFromSnapshots(previous, current);

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "issue.updated");
  assert.deepEqual(events[0].payload.changedFields, [
    "commentsCount",
    "evidenceDigest",
  ]);
  assert.match(events[0].payload.evidenceDigest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(events[0]).includes("attachment URL"), false);
});

test("large issue evidence is digest-bound without entering routing state", () => {
  const description = "复现步骤与附件".repeat(1_500);
  const commentBody = "补充视频".repeat(1_000);
  const items = Array.from({ length: 1_300 }, (_, index) => issue(index + 1, {
    description,
    latestComment: {
      author: "carol",
      body: commentBody,
      createdAt: "2026-08-01T04:00:00.000Z",
      updatedAt: "2026-08-01T04:00:00.000Z",
      url: `https://github.com/acme/repo/issues/${index + 1}#issuecomment-1`,
    },
  }));
  const current = snapshot(items);

  const checkpoint = projectWorkflowSnapshot(current);
  const events = workflowEventsFromSnapshots(null, current);
  const serialized = JSON.stringify({ checkpoint, events });

  assert.equal(events.length, 1_300);
  assert.equal(serialized.includes(description.slice(0, 128)), false);
  assert.equal(serialized.includes(commentBody.slice(0, 128)), false);
  assert.ok(Buffer.byteLength(serialized, "utf8") < 4 * 1024 * 1024);
});

test("a changed PR base target emits a new event even when Head is unchanged", () => {
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
  const previous = snapshot([
    pullRequest(1, {
      headRefOid: gitTarget.headRefOid,
      gitTarget,
      gitTargetAvailable: true,
    }),
  ], { refreshedAt: "2026-08-02T01:00:00.000Z" });
  const current = snapshot([
    pullRequest(1, {
      headRefOid: gitTarget.headRefOid,
      gitTarget: { ...gitTarget, baseRefOid: "c".repeat(40) },
      gitTargetAvailable: true,
    }),
  ]);

  const events = workflowEventsFromSnapshots(previous, current);

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "pull_request.updated");
  assert.equal(events[0].payload.headRefOid, gitTarget.headRefOid);
  assert.equal(events[0].payload.gitTarget.baseRefOid, "c".repeat(40));
  assert.deepEqual(events[0].payload.changedFields, ["gitTarget"]);
});

test("an unhealthy source suppresses all events for only its own item kind", () => {
  const previous = snapshot([pullRequest(1), issue(1)]);
  const current = snapshot([], {
    sourceStatus: {
      githubPullRequests: { ok: false, stale: true },
      githubIssues: { ok: true, stale: false },
    },
  });

  const events = workflowEventsFromSnapshots(previous, current);

  assert.deepEqual(eventTypes(events), [
    "github:issue:acme/repo#1:issue.left_scope",
  ]);
});

test("a contradictory ok and stale source status fails closed", () => {
  const previous = snapshot([pullRequest(1), issue(1)]);
  const current = snapshot([], {
    sourceStatus: {
      githubPullRequests: { ok: true, stale: true },
      githubIssues: { ok: true, stale: true },
    },
  });

  assert.deepEqual(workflowEventsFromSnapshots(previous, current), []);
});

test("a source without a previous healthy baseline observes recovered history", () => {
  const previous = snapshot([], {
    refreshedAt: "2026-08-02T01:00:00.000Z",
    sourceStatus: {
      githubPullRequests: { ok: false, stale: true },
      githubIssues: { ok: true, stale: false },
    },
  });
  const current = snapshot([pullRequest(1), issue(2)]);

  assert.deepEqual(
    eventTypes(workflowEventsFromSnapshots(previous, current)),
    [
      "github:pr:acme/repo#1:pull_request.observed",
      "github:issue:acme/repo#2:issue.created",
    ],
  );
});

test("irrelevant and forbidden snapshot fields do not create update events", () => {
  const previous = snapshot([
    pullRequest(1, { labels: ["backend", "risk:high"] }),
  ]);
  const current = snapshot([
    pullRequest(1, {
      labels: ["risk:high", "backend"],
      token: "rotated-secret",
      env: { GH_TOKEN: "rotated-secret" },
      command: "different-command",
      displayOnlyNoise: "changed",
    }),
  ]);

  assert.deepEqual(workflowEventsFromSnapshots(previous, current), []);
});

test("event content, identity, and ordering are deterministic across repeated input", () => {
  const previous = snapshot([]);
  const current = snapshot([issue(9), pullRequest(8), issue(7)]);

  const first = workflowEventsFromSnapshots(previous, current);
  const repeated = workflowEventsFromSnapshots(previous, current);
  const reordered = workflowEventsFromSnapshots(
    previous,
    snapshot([...current.items].reverse()),
  );

  assert.deepEqual(repeated, first);
  assert.deepEqual(reordered, first);
  assert.deepEqual(
    first.map((event) => event.eventId),
    repeated.map((event) => event.eventId),
  );
});

test("completion requires a transition into a completed state", () => {
  const alreadyClosed = issue(1, { state: "closed" });
  const previous = snapshot([alreadyClosed]);
  const current = snapshot([alreadyClosed]);

  assert.deepEqual(workflowEventsFromSnapshots(previous, current), []);
  assert.deepEqual(
    eventTypes(workflowEventsFromSnapshots(snapshot([issue(1)]), current)),
    [
      "github:issue:acme/repo#1:issue.updated",
      "github:issue:acme/repo#1:issue.status",
      "github:issue:acme/repo#1:issue.completed",
    ],
  );
});
