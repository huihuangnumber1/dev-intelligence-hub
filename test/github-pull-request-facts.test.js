import assert from "node:assert/strict";
import test from "node:test";

import { GitHubAdapter } from "../src/adapters/github-adapter.js";
import { createPullRequestExecutionBinding } from "../src/domain/pull-request-execution-binding.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";
import { projectPullRequestReadFactsContext } from "../src/domain/pull-request-read-facts.js";

const BASE_OID = "a".repeat(40);
const HEAD_OID = "b".repeat(40);

function readRequest({ scopeId = "github-account:runtime-user" } = {}) {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: BASE_OID,
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: HEAD_OID,
  };
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "pull_request.observed",
    occurredAt: "2026-08-08T01:00:00.000Z",
    source: { provider: "github", scopeId },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      headRefOid: HEAD_OID,
      gitTargetAvailable: true,
      gitTarget,
    },
  });
  const executionBinding = createPullRequestExecutionBinding({
    sourceBinding: {
      kind: "pull_request",
      rootItemId: event.subject.id,
      workKey: "root",
      inputRevision: 4,
      headRevision: 4,
      headRefOid: HEAD_OID,
      eventId: event.eventId,
      eventDigest: event.contentDigest,
      inputDigest: "c".repeat(64),
    },
    event,
  });
  return { executionBinding, event };
}

function graphTargetResponse(overrides = {}) {
  return {
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    baseRefName: "main",
    baseRefOid: BASE_OID,
    baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: BASE_OID } },
    headRefName: "fix/conflict",
    headRefOid: HEAD_OID,
    headRef: { name: "fix/conflict", repository: { nameWithOwner: "contributor/repo" }, target: { oid: HEAD_OID } },
    headRepository: { nameWithOwner: "contributor/repo" },
    ...overrides,
  };
}

function currentTargetResponse(target = viewTargetResponse()) {
  const headRepository = target.headRepository?.nameWithOwner ||
    `${target.headRepositoryOwner?.login}/${target.headRepository?.name}`;
  return { data: { repository: { nameWithOwner: "acme/repo", pullRequest: {
    ...graphTargetResponse(),
    number: target.number,
    url: target.url,
    state: target.state,
    author: { login: "author" },
    changedFiles: 1,
    baseRefName: target.baseRefName,
    baseRefOid: target.baseRefOid,
    baseRef: Object.hasOwn(target, "baseRef") ? target.baseRef : { name: target.baseRefName, repository: { nameWithOwner: "acme/repo" }, target: { oid: target.baseRefOid } },
    headRefName: target.headRefName,
    headRefOid: target.headRefOid,
    headRepository: { nameWithOwner: headRepository },
    headRef: Object.hasOwn(target, "headRef") ? target.headRef : { name: target.headRefName, repository: { nameWithOwner: `${target.headRepositoryOwner?.login}/${target.headRepository?.name}` }, target: { oid: target.headRefOid } },
  } } } };
}

function isCurrentTargetCall(args) {
  return args.some((value) => value.startsWith("query=") && value.includes("MyDashboardCurrentPullRequestTarget"));
}

function isFactsCall(args) {
  return args.some((value) => value.startsWith("query=") && value.includes("MyDashboardPullRequestFacts("));
}

function viewTargetResponse(overrides = {}) {
  return {
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    baseRefName: "main",
    baseRefOid: BASE_OID,
    headRefName: "fix/conflict",
    headRefOid: HEAD_OID,
    headRepository: { id: "R_kgDOExample", name: "repo" },
    headRepositoryOwner: {
      id: "U_kgDOExample",
      name: "Contributor",
      login: "contributor",
    },
    state: "OPEN",
    ...overrides,
  };
}

function page(nodes = [], overrides = {}) {
  return {
    nodes,
    pageInfo: { hasPreviousPage: false, hasNextPage: false, ...overrides },
  };
}

function comment(overrides = {}) {
  return {
    id: "IC_comment_1",
    author: { login: "author" },
    body: "Please preserve compatibility.",
    createdAt: "2026-08-08T00:30:00.000Z",
    updatedAt: "2026-08-08T00:31:00.000Z",
    url: "https://github.com/acme/repo/pull/42#issuecomment-1",
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    id: "PRR_review_1",
    author: { login: "reviewer" },
    state: "CHANGES_REQUESTED",
    submittedAt: "2026-08-08T00:40:00.000Z",
    commit: { oid: HEAD_OID },
    body: "There is one blocking race.",
    url: "https://github.com/acme/repo/pull/42#pullrequestreview-1",
    ...overrides,
  };
}

function threadComment(overrides = {}) {
  return {
    ...comment({
      id: "PRRC_comment_2",
      url: "https://github.com/acme/repo/pull/42#discussion_r2",
    }),
    pullRequestReview: {
      id: "PRR_review_1",
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-08-08T00:40:00.000Z",
      commit: { oid: HEAD_OID },
    },
    ...overrides,
  };
}

function reviewThread(overrides = {}) {
  return {
    id: "PRRT_thread_1",
    path: "src/index.js",
    line: 12,
    originalLine: 10,
    isResolved: false,
    isOutdated: false,
    comments: page([threadComment()]),
    ...overrides,
  };
}

function checkRun(overrides = {}) {
  return {
    __typename: "CheckRun",
    name: "unit",
    status: "COMPLETED",
    conclusion: "SUCCESS",
    detailsUrl: "https://github.com/acme/repo/actions/runs/1",
    startedAt: "2026-08-08T00:20:00.000Z",
    completedAt: "2026-08-08T00:25:00.000Z",
    isRequired: true,
    ...overrides,
  };
}

function statusContext(overrides = {}) {
  return {
    __typename: "StatusContext",
    context: "license",
    state: "PENDING",
    targetUrl: "https://ci.example.test/license/1",
    createdAt: "2026-08-08T00:22:00.000Z",
    isRequired: false,
    ...overrides,
  };
}

function graphResponse(overrides = {}) {
  const pullRequest = {
    ...graphTargetResponse(),
    reviewDecision: "CHANGES_REQUESTED",
    comments: page([comment()]),
    reviews: page([review()]),
    reviewThreads: page([reviewThread()]),
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: page([checkRun(), statusContext()]),
            },
          },
        },
      ],
    },
    ...overrides,
  };
  return { data: { repository: { pullRequest } } };
}

function fakeRun({
  graph = graphResponse(),
  initialTarget,
  finalTarget,
  finalAccount,
} = {}) {
  const calls = [];
  let targetReads = 0;
  let accountReads = 0;
  const run = async (_command, args, options) => {
    calls.push({ args, options });
    if (isCurrentTargetCall(args)) {
      targetReads += 1;
      const target = targetReads === 1 && initialTarget ? initialTarget :
        targetReads === 2 && finalTarget ? finalTarget : viewTargetResponse();
      return currentTargetResponse(target);
    }
    if (isFactsCall(args)) return graph;
    if (args[0] === "api") {
      accountReads += 1;
      return {
        login:
          accountReads === 2 && finalAccount ? finalAccount : "runtime-user",
      };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  return { calls, run };
}

test("current Ref owner identity is accepted at both target reads", async () => {
  const owner = { login: "contributor" };
  const fake = fakeRun({
    initialTarget: viewTargetResponse({ headRepositoryOwner: owner }),
    finalTarget: viewTargetResponse({ headRepositoryOwner: owner }),
  });
  const adapter = new GitHubAdapter({ run: fake.run });

  const facts = await adapter.loadPullRequestFacts(readRequest());

  assert.equal(facts.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(
    fake.calls.filter(({ args }) => isCurrentTargetCall(args)).length,
    2,
  );
});

test("current Ref repository identity is accepted at both target reads", async () => {
  const headRepository = {
    id: "R_kgDOExample",
    name: "repo",
    nameWithOwner: "",
  };
  const fake = fakeRun({
    initialTarget: viewTargetResponse({ headRepository }),
    finalTarget: viewTargetResponse({ headRepository }),
  });
  const adapter = new GitHubAdapter({ run: fake.run });

  const facts = await adapter.loadPullRequestFacts(readRequest());

  assert.equal(facts.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(
    fake.calls.filter(({ args }) => isCurrentTargetCall(args)).length,
    2,
  );
});

test("contradictory current Ref repository identity is rejected", async () => {
  const fake = fakeRun({
    initialTarget: viewTargetResponse({
      headRepository: {
        id: "R_kgDOExample",
        name: "repo",
        nameWithOwner: "other/repo",
      },
    }),
  });
  const adapter = new GitHubAdapter({ run: fake.run });

  await assert.rejects(
    adapter.loadPullRequestFacts(readRequest()),
    (error) => error.code === "GITHUB_PULL_REQUEST_FACTS_INVALID",
  );
  assert.equal(
    fake.calls.filter(
      ({ args }) => isFactsCall(args),
    ).length,
    0,
  );
});

test("the bounded GraphQL read returns detailed facts without changing summaries", async () => {
  const fake = fakeRun();
  const adapter = new GitHubAdapter({
    run: fake.run,
    clock: () => new Date("2026-08-08T01:02:00.000Z"),
  });

  const facts = await adapter.loadPullRequestFacts(readRequest());

  assert.equal(facts.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(facts.comments[0].author, "author");
  assert.equal(facts.reviews[0].commitOid, HEAD_OID);
  assert.equal(facts.reviewThreads[0].resolved, false);
  assert.equal(facts.reviewThreads[0].outdated, false);
  assert.equal(facts.reviewThreads[0].comments[0].reviewState, "CHANGES_REQUESTED");
  assert.deepEqual(
    facts.checks.map(({ name, requirement }) => [name, requirement]),
    [
      ["unit", "required"],
      ["license", "optional"],
    ],
  );
  assert.equal(facts.checks[1].status, "PENDING");
  assert.equal(facts.checks[1].conclusion, "NONE");
  assert.equal(facts.observedAt, "2026-08-08T01:02:00.000Z");
  assert.equal(Object.isFrozen(facts), true);

  const graphCall = fake.calls.find(({ args }) => isFactsCall(args));
  assert.ok(graphCall.args.includes("commentCount=20"));
  assert.ok(graphCall.args.includes("reviewCount=20"));
  assert.ok(graphCall.args.includes("threadCount=20"));
  assert.ok(graphCall.args.includes("threadCommentCount=5"));
  assert.ok(graphCall.args.includes("checkCount=50"));
  assert.match(
    graphCall.args.find((entry) => entry.startsWith("query=")),
    /comments\(last: \$commentCount\)/u,
  );
  assert.match(
    graphCall.args.find((entry) => entry.startsWith("query=")),
    /isRequired\(pullRequestNumber: \$number\)/u,
  );
  assert.equal(graphCall.options.timeoutMs, 60_000);
  assert.equal(
    fake.calls.filter(({ args }) => isCurrentTargetCall(args)).length,
    2,
  );
  assert.equal(
    fake.calls.filter(({ args }) => args.at(-1) === "user").length,
    2,
  );
});

test("historical PR base scalars cannot replace the current base Ref in any facts read", async () => {
  const liveBase = {
    name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: BASE_OID },
  };
  const historicalTarget = viewTargetResponse({ baseRefOid: "d".repeat(40), baseRef: liveBase });
  const fake = fakeRun({
    initialTarget: historicalTarget,
    finalTarget: historicalTarget,
    graph: graphResponse({ baseRefOid: "d".repeat(40), baseRef: liveBase }),
  });

  const facts = await new GitHubAdapter({ run: fake.run }).loadPullRequestFacts(readRequest());

  assert.equal(facts.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(fake.calls.filter(({ args }) => isCurrentTargetCall(args)).length, 2);
  assert.equal(fake.calls.filter(({ args }) => isFactsCall(args)).length, 1);
  assert.equal(fake.calls.filter(({ args }) => args[0] === "pr").length, 0);
});

test("a live base that moved before the read fails before downloading detailed facts", async () => {
  const fake = fakeRun({ initialTarget: viewTargetResponse({
    baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: "d".repeat(40) } },
  }) });

  await assert.rejects(new GitHubAdapter({ run: fake.run }).loadPullRequestFacts(readRequest()),
    (error) => error.code === "PR_FACTS_STALE");
  assert.equal(fake.calls.filter(({ args }) => isFactsCall(args)).length, 0);
});

test("deleted and invalid live Refs cannot fall back to historical scalars for facts", async (t) => {
  const cases = [
    ["deleted base", { baseRef: null }],
    ["deleted head", { headRef: null }],
    ["invalid base oid", { baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: "not-a-commit" } } }],
    ["wrong base repository", { baseRef: { name: "main", repository: { nameWithOwner: "other/repo" }, target: { oid: BASE_OID } } }],
    ["head Ref and PR disagree", { headRef: { name: "fix/conflict", repository: { nameWithOwner: "contributor/repo" }, target: { oid: "d".repeat(40) } } }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const fake = fakeRun({ initialTarget: viewTargetResponse(overrides) });
      await assert.rejects(new GitHubAdapter({ run: fake.run }).loadPullRequestFacts(readRequest()),
        (error) => error.code === "GITHUB_PULL_REQUEST_FACTS_INVALID");
      assert.equal(fake.calls.filter(({ args }) => isFactsCall(args)).length, 0);
    });
  }
});

test("invalid live Refs within detailed facts are rejected before final target validation", async (t) => {
  for (const [name, overrides] of [
    ["deleted base", { baseRef: null }],
    ["deleted head", { headRef: null }],
    ["invalid base oid", { baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: "not-a-commit" } } }],
  ]) {
    await t.test(name, async () => {
      const fake = fakeRun({ graph: graphResponse(overrides) });
      await assert.rejects(new GitHubAdapter({ run: fake.run }).loadPullRequestFacts(readRequest()),
        (error) => error.code === "GITHUB_PULL_REQUEST_FACTS_INVALID");
      assert.equal(fake.calls.filter(({ args }) => isCurrentTargetCall(args)).length, 1);
    });
  }
});

test("HTTP Jenkins links survive fact projection as data for the configured diagnostic reader", async () => {
  const graph = graphResponse({
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: page([
                statusContext({ targetUrl: "http://ci.example.test/build/1" }),
              ]),
            },
          },
        },
      ],
    },
  });
  const adapter = new GitHubAdapter({ run: fakeRun({ graph }).run });

  const facts = await adapter.loadPullRequestFacts(readRequest());

  assert.equal(facts.checks.length, 1);
  assert.equal(facts.checks[0].name, "license");
  assert.equal(facts.checks[0].status, "PENDING");
  assert.equal(facts.checks[0].url, "http://ci.example.test/build/1");
});

test("unknown GitHub enums and nullable facts are explicit and fail-safe", async () => {
  const graph = graphResponse({
    reviewDecision: "FUTURE_DECISION",
    comments: page([
      comment({
        author: null,
        createdAt: "2026-08-08T00:30:00Z",
        updatedAt: "2026-08-08T00:31:00.123456Z",
      }),
    ]),
    reviews: page([
      review({
        state: "FUTURE_REVIEW_STATE",
        submittedAt: null,
        commit: null,
      }),
    ]),
    reviewThreads: page([
      reviewThread({
        line: null,
        originalLine: null,
        isResolved: null,
        isOutdated: null,
      }),
    ]),
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: page([
                checkRun({
                  status: "FUTURE",
                  conclusion: "FUTURE",
                  isRequired: false,
                }),
              ]),
            },
          },
        },
      ],
    },
  });
  const adapter = new GitHubAdapter({
    run: fakeRun({ graph }).run,
    clock: () => "2026-08-08T01:02:00.000Z",
  });

  const facts = await adapter.loadPullRequestFacts(readRequest());

  assert.equal(facts.reviewDecision, "UNKNOWN");
  assert.equal(facts.comments[0].author, "");
  assert.equal(facts.comments[0].createdAt, "2026-08-08T00:30:00.000Z");
  assert.equal(facts.comments[0].updatedAt, "2026-08-08T00:31:00.123Z");
  assert.equal(facts.reviews[0].state, "UNKNOWN");
  assert.equal(facts.reviews[0].submittedAt, null);
  assert.equal(facts.reviews[0].commitOid, "");
  assert.equal(facts.reviewThreads[0].resolved, null);
  assert.equal(facts.checks[0].status, "UNKNOWN");
  assert.equal(facts.checks[0].conclusion, "UNKNOWN");
  assert.equal(facts.checks[0].requirement, "optional");
});

test("default reads retain long discussion bodies and prove unchanged material without enlarging model context", async () => {
  const body = '原始评审说明'.repeat(2_400), reviewBody = 'r'.repeat(32_000);
  const graph = graphResponse({ comments: page([comment({ body })]), reviews: page([review({ body: reviewBody })]) });
  let now = '2026-08-08T01:02:00.000Z';
  const adapter = new GitHubAdapter({ run: fakeRun({ graph }).run, clock: () => now });
  const first = await adapter.loadPullRequestFacts(readRequest());
  assert.equal(first.comments[0].body === body, true);
  assert.equal(first.comments[0].bodyTruncated, false);
  assert.equal(first.reviews[0].body === reviewBody, true);
  assert.equal(first.reviews[0].bodyTruncated, false);
  const original = projectPullRequestReadFactsContext(first);
  assert.match(original.materialDigest, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(original)) <= 64 * 1024);
  now = '2026-08-08T01:03:00.000Z';
  const refreshed = projectPullRequestReadFactsContext(await adapter.loadPullRequestFacts(readRequest()));
  assert.notEqual(original.contentDigest, refreshed.contentDigest);
  assert.equal(original.materialDigest, refreshed.materialDigest);
  graph.data.repository.pullRequest.comments.nodes[0].body = body.slice(0, -1) + '改';
  const changed = projectPullRequestReadFactsContext(await adapter.loadPullRequestFacts(readRequest()));
  assert.deepEqual(changed.comments, refreshed.comments);
  assert.notEqual(changed.materialDigest, refreshed.materialDigest, 'a hidden tail edit must invalidate the material proof');
});

test("bodies above the bounded source limit still disclose truncation and cannot prove complete material", async () => {
  const graph = graphResponse({ comments: page([comment({ body: 'x'.repeat(70_000) })]) });
  const facts = await new GitHubAdapter({ run: fakeRun({ graph }).run }).loadPullRequestFacts(readRequest());
  assert.equal(facts.comments[0].bodyTruncated, true);
  assert.ok(Buffer.byteLength(facts.comments[0].body) <= 64 * 1024);
  assert.equal(Object.hasOwn(projectPullRequestReadFactsContext(facts), 'materialDigest'), false);
});

test("server pagination, body limits, and the total byte budget remain visible", async () => {
  const comments = Array.from({ length: 12 }, (_, index) =>
    comment({
      id: `IC_comment_${index}`,
      body: `comment-${index}-` + "x".repeat(4_000),
    }),
  );
  const graph = graphResponse({
    comments: page(comments, { hasPreviousPage: true }),
  });
  const adapter = new GitHubAdapter({
    run: fakeRun({ graph }).run,
    maxReadComments: 12,
    maxReadBodyBytes: 1_024,
    maxReadFactBytes: 9_000,
    clock: () => "2026-08-08T01:02:00.000Z",
  });

  const facts = await adapter.loadPullRequestFacts(readRequest());

  assert.equal(facts.truncation.comments, true);
  assert.equal(facts.truncation.byteBudget, true);
  assert.ok(facts.comments.length < comments.length);
  assert.ok(facts.comments.every(({ bodyTruncated }) => bodyTruncated));
  assert.ok(Buffer.byteLength(JSON.stringify(facts), "utf8") <= 9_000);
});

test("a response exceeding its declared single-page limit is rejected", async () => {
  const graph = graphResponse({
    comments: page([comment({ id: "one" }), comment({ id: "two" })]),
  });
  const adapter = new GitHubAdapter({
    run: fakeRun({ graph }).run,
    maxReadComments: 1,
  });

  await assert.rejects(
    adapter.loadPullRequestFacts(readRequest()),
    (error) => error.code === "GITHUB_PULL_REQUEST_FACTS_INVALID",
  );
});

test("facts returned for another atomic target are discarded before final validation", async () => {
  const fake = fakeRun({
    graph: graphResponse({ baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: "d".repeat(40) } } }),
  });
  const adapter = new GitHubAdapter({ run: fake.run });

  await assert.rejects(
    adapter.loadPullRequestFacts(readRequest()),
    (error) => error.code === "PR_FACTS_STALE",
  );
  assert.equal(
    fake.calls.filter(({ args }) => isCurrentTargetCall(args)).length,
    1,
  );
});

test("a terminal PR is rejected before the detailed facts read", async () => {
  const fake = fakeRun({
    initialTarget: viewTargetResponse({ state: "MERGED" }),
  });
  const adapter = new GitHubAdapter({ run: fake.run });

  await assert.rejects(
    adapter.loadPullRequestFacts(readRequest()),
    (error) =>
      error.code === "PR_FACTS_TERMINAL" &&
      error.terminalState === "MERGED",
  );
  assert.equal(
    fake.calls.filter(
      ({ args }) => isFactsCall(args),
    ).length,
    0,
  );
});

test("closed and merged PRs remain terminal when their live Refs have been deleted", async (t) => {
  for (const state of ["CLOSED", "MERGED"]) {
    await t.test(state, async () => {
      const fake = fakeRun({ initialTarget: viewTargetResponse({ state, baseRef: null, headRef: null }) });
      await assert.rejects(new GitHubAdapter({ run: fake.run }).loadPullRequestFacts(readRequest()),
        (error) => error.code === "PR_FACTS_TERMINAL" && error.terminalState === state);
      assert.equal(fake.calls.filter(({ args }) => isFactsCall(args)).length, 0);
    });
  }
});

test("a PR that closes during the bounded read is reported as terminal", async () => {
  const fake = fakeRun({
    finalTarget: viewTargetResponse({ state: "CLOSED" }),
  });
  const adapter = new GitHubAdapter({ run: fake.run });

  await assert.rejects(
    adapter.loadPullRequestFacts(readRequest()),
    (error) =>
      error.code === "PR_FACTS_TERMINAL" &&
      error.terminalState === "CLOSED",
  );
  assert.equal(
    fake.calls.filter(
      ({ args }) => isFactsCall(args),
    ).length,
    1,
  );
});

test("a changed Head, base, repository, ref, or account fails last-hop validation", async (t) => {
  const changes = [
    ["Head", { headRefOid: "d".repeat(40) }, null],
    ["base OID", { baseRefOid: "d".repeat(40) }, null],
    [
      "head repository",
      {
        headRepositoryOwner: {
          id: "U_kgDOOther",
          name: "Other",
          login: "other",
        },
      },
      null,
    ],
    ["head ref", { headRefName: "other/ref" }, null],
    ["account", null, "other-user"],
  ];
  for (const [name, targetOverride, account] of changes) {
    await t.test(name, async () => {
      const fake = fakeRun({
        finalTarget: targetOverride
          ? viewTargetResponse(targetOverride)
          : undefined,
        finalAccount: account,
      });
      const adapter = new GitHubAdapter({ run: fake.run });
      await assert.rejects(
        adapter.loadPullRequestFacts(readRequest()),
        (error) => error.code === "PR_FACTS_STALE",
      );
    });
  }
});

test("an event provenance mismatch fails before any GitHub I/O", async () => {
  const first = readRequest({ scopeId: "scope:first" });
  const second = readRequest({ scopeId: "scope:second" });
  let calls = 0;
  const adapter = new GitHubAdapter({
    run: async () => {
      calls += 1;
      throw new Error("must not run");
    },
  });

  await assert.rejects(
    adapter.loadPullRequestFacts({
      executionBinding: first.executionBinding,
      event: second.event,
    }),
    (error) => error.code === "INVALID_PULL_REQUEST_READ_FACTS",
  );
  assert.equal(calls, 0);
});

test("proxied and accessor-bearing GitHub payloads never execute application code", async (t) => {
  let traps = 0;
  const proxy = {
    data: new Proxy(
      { repository: { pullRequest: null } },
      {
        get() {
          traps += 1;
          throw new Error("must not execute");
        },
      },
    ),
  };
  const accessor = {};
  Object.defineProperty(accessor, "data", {
    enumerable: true,
    get() {
      traps += 1;
      throw new Error("must not execute");
    },
  });

  for (const [name, graph] of [["proxy", proxy], ["accessor", accessor]]) {
    await t.test(name, async () => {
      const adapter = new GitHubAdapter({ run: fakeRun({ graph }).run });
      await assert.rejects(
        adapter.loadPullRequestFacts(readRequest()),
        (error) => error.code === "GITHUB_PULL_REQUEST_FACTS_INVALID",
      );
    });
  }
  assert.equal(traps, 0);
});
