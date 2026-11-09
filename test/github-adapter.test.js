import assert from "node:assert/strict";
import test from "node:test";
import { assessPullRequestResponsibility } from "../src/domain/pr-responsibility.js";
import { workflowEventsFromSnapshots } from "../src/domain/workflow-snapshot-events.js";
import { withPrLifecycleRoutes } from "../src/domain/pr-lifecycle-routing.js";
import { routeWorkflowEvent } from "../src/domain/workflow-router.js";
import {
  GitHubAdapter,
  classifyPullRequestRelation,
  combinePullRequestRecords,
  summarizeCheckStatus,
  summarizeReviewFacts,
} from "../src/adapters/github-adapter.js";

function currentTargetPr(overrides = {}) {
  const target = {
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    state: "OPEN",
    author: { login: "contributor" },
    assignees: [{ login: 'runtime-user' }],
    changedFiles: 1,
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRefName: "fix/conflict",
    headRefOid: "b".repeat(40),
    headRepository: { nameWithOwner: "contributor/repo" },
    ...overrides,
  };
  return {
    ...target,
    baseRef: Object.hasOwn(overrides, "baseRef") ? overrides.baseRef : {
      name: target.baseRefName, repository: { nameWithOwner: "acme/repo" }, target: { oid: target.baseRefOid },
    },
    headRef: Object.hasOwn(overrides, "headRef") ? overrides.headRef : {
      name: target.headRefName, repository: target.headRepository, target: { oid: target.headRefOid },
    },
  };
}

function currentTargetResponse(overrides = {}) {
  return { data: { repository: { nameWithOwner: "acme/repo", pullRequest: currentTargetPr(overrides) } } };
}

function isCurrentTargetCall(args) {
  return args.some((value) => value.startsWith("query=") && value.includes("MyDashboardCurrentPullRequestTarget("));
}

function isCurrentTargetBatchCall(args) {
  return args.some((value) => value.startsWith("query=") && value.includes("MyDashboardCurrentPullRequestTargets {"));
}

function currentTargetBatchResponse(args, target = (number) => ({ number, url: `https://github.com/acme/repo/pull/${number}` })) {
  const query = args.find((value) => value.startsWith("query="));
  const aliases = [...query.matchAll(/(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)\s*\{\s*nameWithOwner pullRequest\(number:(\d+)\)/gu)];
  assert.ok(aliases.length > 0, "current-target batch must have aliased repository selections");
  return { data: Object.fromEntries(aliases.map(([, alias, owner, name, number]) => [alias, {
    nameWithOwner: `${owner}/${name}`, pullRequest: currentTargetPr(target(Number(number))),
  }])) };
}

test("fresh incoming approval updates shared facts without creating testing work for another author", async () => {
  const head = "b".repeat(40);
  const approved = { author: { login: "runtime-user" }, state: "APPROVED",
    submittedAt: "2026-10-16T01:00:00Z", commit: { oid: head } };
  for (const reviews of [[approved], [approved, { ...approved, state: "COMMENTED", submittedAt: "2026-10-16T02:00:00Z" }]]) {
    const record = { number: 42, title: "PR 42", url: "https://github.com/acme/repo/pull/42",
      repository: { nameWithOwner: "acme/repo" }, author: { login: "contributor" }, state: "open",
      updatedAt: "2026-10-16T02:00:00Z" };
    const adapter = new GitHubAdapter({ readIncomingReviews: true, run: async (_command, args) => {
      if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args);
      if (args[0] === "api" && args.includes("graphql")) return { data: { repository: { pullRequest: {
        number: 42, url: record.url, state: "OPEN", headRefOid: head, author: record.author,
        timelineItems: { nodes: [] }, assignees: { nodes: [] }, reviews: { nodes: reviews },
      } } } };
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search") return args.includes("--assignee=@me") ? [record] : [];
      if (args[0] === "pr") return { ...currentTargetPr(), labels: [], statusCheckRollup: [],
        reviews: [{ ...approved, state: "CHANGES_REQUESTED", submittedAt: "2026-10-15T00:00:00Z", commit: { oid: "c".repeat(40) } }] };
      assert.fail(`Unexpected command: ${args.join(" ")}`);
    } });
    const [item] = await adapter.searchRelevantPullRequests();
    assert.equal(item.myReviewState, "APPROVED");
    assert.equal(item.myReviewCommitOid, head);
    assert.equal(item.myReviewAt, approved.submittedAt);
    const classified = { ...item, ...assessPullRequestResponsibility(item, { now: "2026-10-16T03:00:00Z" }) };
    assert.equal(classified.nextAction, "wait_merge");
    const [event] = workflowEventsFromSnapshots(null, { refreshedAt: "2026-10-16T03:00:00.000Z", items: [classified],
      sourceStatus: { githubPullRequests: { ok: true, stale: false } } }, { sourceScopeId: "dashboard" });
    const routed = routeWorkflowEvent({ event, config: withPrLifecycleRoutes({ schemaVersion: 1, enabled: true, maxHops: 8, rules: [] }) });
    assert.equal(classified.relation, "review_requested");
    assert.deepEqual(routed.assignments, []);
  }
});

test("a pull request assigned to me by another author means review", () => {
  assert.equal(
    classifyPullRequestRelation("assigned", "local-owner", "other-user"),
    "review_requested",
  );
});

test("my own assigned pull request remains my modification work", () => {
  assert.equal(
    classifyPullRequestRelation("assigned", "local-owner", "local-owner"),
    "authored",
  );
});

test("assigned and authored searches combine before detail lookup", () => {
  const own = {
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "local-owner" },
  };
  const assignedByOther = {
    number: 8,
    url: "https://github.com/acme/repo/pull/8",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "someone-else" },
  };

  const combined = combinePullRequestRecords(
    [own, assignedByOther],
    [own],
    "local-owner",
  );

  assert.equal(combined.length, 2);
  assert.deepEqual(
    combined.find((record) => record.number === 7).relationSources,
    ["assignee", "author"],
  );
  assert.equal(
    combined.find((record) => record.number === 7).relation,
    "authored",
  );
  assert.equal(
    combined.find((record) => record.number === 8).relation,
    "review_requested",
  );
});

test('personal PR discovery searches only assignments and authorship', async () => {
  const searches = [];
  const adapter = new GitHubAdapter({ run: async (_command, args) => {
    if (args[0] === 'api') return { login: 'runtime-user' };
    if (args[0] === 'search') { searches.push(args); return []; }
    assert.fail('empty personal searches require no PR detail reads');
  } });
  assert.deepEqual(await adapter.searchRelevantPullRequests(), []);
  assert.equal(searches.length, 2);
  assert.ok(searches.every(args => args.includes('--assignee=@me') || args.includes('--author=@me')));
});

test('fresh assignment takes precedence over authorship in both discovery methods', async t => {
  for (const { name, owned, assignees, expected } of [
    { name: 'unassigned non-author', owned: false, assignees: [], expected: 0 },
    { name: 'unassigned author', owned: true, assignees: [], expected: 1 },
    { name: 'author assigned elsewhere', owned: true, assignees: ['qa'], expected: 0 },
    { name: 'author still assigned', owned: true, assignees: ['RUNTIME-USER', 'qa'], expected: 1 },
  ]) await t.test(name, async () => {
    const record = { number: 42, title: 'PR', url: 'https://github.com/acme/repo/pull/42',
      repository: { nameWithOwner: 'acme/repo' }, author: { login: owned ? 'runtime-user' : 'contributor' } };
    const adapter = new GitHubAdapter({ run: async (_command, args) => {
      if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args);
      if (args[0] === 'api') return { login: 'runtime-user' };
      if (args[0] === 'search') return args.includes('--assignee=@me') ? [record] : [];
      if (args[0] === 'pr') return { ...currentTargetPr(), assignees: assignees.map(login => ({ login })), labels: [], reviews: [], statusCheckRollup: [] };
      assert.fail('Unexpected command');
    } });
    assert.equal((await adapter.searchRelevantPullRequests()).length, expected);
    assert.equal((await adapter.searchPullRequests('assigned', 'runtime-user')).length, expected);
  });
});

test('incomplete assignment facts fail discovery instead of retiring a previously assigned PR', async () => {
  const record = { number: 42, title: 'PR', url: 'https://github.com/acme/repo/pull/42',
    repository: { nameWithOwner: 'acme/repo' }, author: { login: 'contributor' } };
  const adapter = new GitHubAdapter({ run: async (_command, args) => {
    if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args);
    if (args[0] === 'api') return { login: 'runtime-user' };
    if (args[0] === 'search') return args.includes('--assignee=@me') ? [record] : [];
    const detail = currentTargetPr(); delete detail.assignees; return detail;
  } });
  await assert.rejects(adapter.searchRelevantPullRequests(), /assignment facts are incomplete/);
});

test("review facts retain the commit reviewed by each responsible person", () => {
  const facts = summarizeReviewFacts(
    [
      {
        author: { login: "local-owner" },
        state: "COMMENTED",
        submittedAt: "2026-07-20T09:00:00Z",
        commit: { oid: "head-1" },
      },
      {
        author: { login: "local-owner" },
        state: "APPROVED",
        submittedAt: "2026-07-21T09:00:00Z",
        commit: { oid: "head-2" },
      },
      {
        author: { login: "local-owner" },
        state: "COMMENTED",
        submittedAt: "2026-07-23T09:00:00Z",
        commit: { oid: "head-3" },
      },
      {
        author: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-22T09:00:00Z",
        commit: { oid: "head-3" },
      },
    ],
    "local-owner",
  );

  assert.equal(facts.myReviewState, "APPROVED");
  assert.equal(facts.myReviewCommitOid, "head-2");
  assert.equal(facts.myLatestPublishedReviewState, "COMMENTED");
  assert.equal(facts.myLatestPublishedReviewCommitOid, "head-3");
  assert.equal(facts.latestOtherDecisionState, "CHANGES_REQUESTED");
  assert.equal(facts.latestOtherDecisionCommitOid, "head-3");
  assert.equal(facts.latestChangeRequestCommitOid, "head-3");
  assert.deepEqual(facts.outstandingChangeRequestCommitOids, ["head-3"]);
});

test("resolved reviewer feedback is excluded from outstanding change requests", () => {
  const facts = summarizeReviewFacts(
    [
      {
        author: { login: "reviewer-a" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-20T09:00:00Z",
        commit: { oid: "head-1" },
      },
      {
        author: { login: "reviewer-a" },
        state: "APPROVED",
        submittedAt: "2026-07-22T09:00:00Z",
        commit: { oid: "head-2" },
      },
      {
        author: { login: "reviewer-b" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-07-21T09:00:00Z",
        commit: { oid: "head-1" },
      },
    ],
    "local-owner",
  );

  assert.deepEqual(facts.outstandingChangeRequestCommitOids, ["head-1"]);
});

test("check summaries never treat cancelled, pending, or unknown states as success", () => {
  assert.equal(
    summarizeCheckStatus([{ conclusion: "CANCELLED" }]),
    "FAILURE",
  );
  assert.equal(
    summarizeCheckStatus([{ status: "WAITING" }]),
    "PENDING",
  );
  assert.equal(
    summarizeCheckStatus([{ conclusion: "NEW_FUTURE_STATE" }]),
    "UNKNOWN",
  );
  assert.equal(
    summarizeCheckStatus([
      { status: "IN_PROGRESS" },
      { conclusion: "FAILURE" },
    ]),
    "FAILURE",
  );
  assert.equal(
    summarizeCheckStatus([
      { conclusion: "FAILURE" },
      { status: "IN_PROGRESS" },
    ]),
    "FAILURE",
  );
});

test("every GitHub command is pinned to github.com through an explicit environment", async () => {
  const calls = [];
  const sourceEnvironment = {
    GH_HOST: "enterprise.example.com",
    PATH: process.env.PATH || "",
  };
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "api") return { login: "runtime-user" };
    if (args[0] === "search") return [];
    if (args[0] === "pr") {
      return { headRefOid: "head-42", files: [] };
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };
  const runText = async (command, args, options) => {
    calls.push({ command, args, options });
    return "diff";
  };
  const adapter = new GitHubAdapter({
    run,
    runText,
    env: sourceEnvironment,
  });

  await adapter.searchRelevantPullRequests();
  await adapter.searchIssues();
  await adapter.loadReviewContext({
    id: "github:pr:acme/repo#42",
    repo: "acme/repo",
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    headRefOid: "head-42",
  });

  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.command === "gh"));
  assert.ok(
    calls.every((call) => call.options.env.GH_HOST === "github.com"),
  );
  assert.ok(
    calls.every((call) => call.options.env.PATH === sourceEnvironment.PATH),
  );
  assert.equal(sourceEnvironment.GH_HOST, "enterprise.example.com");
  assert.equal(
    calls.find((call) => call.args[0] === "pr" && call.args[1] === "diff")
      .options.timeoutMs,
    60_000,
  );
});

test("refresh-facing GitHub reads forward one shutdown signal to every command", async () => {
  const calls = [];
  const controller = new AbortController();
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "search") return [];
    if (args[0] === "api" && args.at(-1) === "user") {
      return { login: "runtime-user" };
    }
    if (args[0] === "api" && args[1]?.includes("milestones")) return [];
    if (args[0] === "api" && args[1]?.includes("releases")) return [];
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };
  const adapter = new GitHubAdapter({ run });
  const options = { signal: controller.signal };

  await adapter.searchRelevantPullRequests(options);
  await adapter.searchIssues(options);
  await adapter.versions(["acme/repo"], options);

  assert.equal(calls.length, 7);
  assert.ok(calls.every((call) => call.command === "gh"));
  assert.ok(calls.every((call) => call.options.signal === controller.signal));
});

test("assigned issues include bounded context, milestone, and latest discussion", async () => {
  const calls = [];
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      calls.push(args);
      if (args[0] === "search") {
        return [{
          id: "I_issue_12855",
          number: 12855,
          title: "数据库初始化失败",
          body: "search fallback",
          url: "https://github.com/example-medical/example-product/issues/12855",
          repository: { nameWithOwner: "example-medical/example-product" },
          updatedAt: "2026-08-08T09:12:17Z",
          createdAt: "2026-08-08T03:08:53Z",
          author: { login: "SV-author" },
          state: "open",
          labels: [{ name: "S4 Highly desired" }],
          assignees: [{ login: "SV-li-zhenhui" }],
          commentsCount: 1,
        }];
      }
      if (args[0] === "api" && args[1] === "graphql") {
        return {
          data: {
            nodes: [{
              id: "I_issue_12855",
              number: 12855,
              body: "# Problem Statement\n启动后首次进入患者页失败",
              milestone: { title: "Review Request" },
              comments: {
                totalCount: 1,
                nodes: [{
                  author: { login: "SV-author" },
                  body: "已经增加日志，可以先移出 440",
                  createdAt: "2026-08-08T09:12:06Z",
                  updatedAt: "2026-08-08T09:12:06Z",
                  url: "https://github.com/example/comment",
                }],
              },
              closedByPullRequestsReferences: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  number: 7,
                  title: "Fix initialization",
                  state: "MERGED",
                  mergedAt: "2026-08-09T00:00:00Z",
                  repository: { nameWithOwner: "example-medical/example-product" },
                }],
              },
              timelineItems: {
                pageInfo: { hasPreviousPage: false },
                nodes: [
                  { source: { number: 7, title: "Fix initialization", state: "MERGED", mergedAt: "2026-08-09T00:00:00Z", repository: { nameWithOwner: "example-medical/example-product" } } },
                  { source: { number: 8, title: "Mention only", state: "OPEN", mergedAt: null, repository: { nameWithOwner: "example-medical/another-repo" } } },
                  { source: {} },
                ],
              },
            }],
          },
        };
      }
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  const [issue] = await adapter.searchIssues();

  assert.equal(issue.description, "# Problem Statement\n启动后首次进入患者页失败");
  assert.equal(issue.milestone, "Review Request");
  assert.equal(issue.commentsCount, 1);
  assert.deepEqual(issue.latestComment, {
    author: "SV-author",
    body: "已经增加日志，可以先移出 440",
    createdAt: "2026-08-08T09:12:06Z",
    updatedAt: "2026-08-08T09:12:06Z",
    url: "https://github.com/example/comment",
  });
  assert.deepEqual(issue.pullRequestLinks, {
    complete: true,
    links: [
      {
        repo: "example-medical/example-product",
        number: 7,
        title: "Fix initialization",
        state: "merged",
        relation: "formal",
        url: "https://github.com/example-medical/example-product/pull/7",
      },
      {
        repo: "example-medical/another-repo",
        number: 8,
        title: "Mention only",
        state: "open",
        relation: "mention",
        url: "https://github.com/example-medical/another-repo/pull/8",
      },
    ],
  });
  const graphql = calls.find((args) => args[0] === "api");
  assert.ok(graphql.includes("ids[]=I_issue_12855"));
  const search = calls.find((args) => args[0] === "search");
  assert.deepEqual(
    search.slice(search.indexOf("--limit"), search.indexOf("--json")),
    ["--limit", "1000", "--sort", "updated", "--order", "desc"],
  );
});

test("assigned issue details are enriched in GitHub's bounded node batches", async () => {
  const records = Array.from({ length: 101 }, (_, index) => ({
    id: `I_issue_${index + 1}`,
    number: index + 1,
    title: `Issue ${index + 1}`,
    url: `https://github.com/acme/repo/issues/${index + 1}`,
    repository: { nameWithOwner: "acme/repo" },
    updatedAt: "2026-08-26T00:00:00Z",
    createdAt: "2026-08-26T00:00:00Z",
    author: { login: "author" },
    state: "open",
    labels: [],
    assignees: [{ login: "local-owner" }],
  }));
  const graphqlBatchSizes = [];
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "search") return records;
      if (args[0] === "api" && args[1] === "graphql") {
        const ids = args
          .filter((argument) => argument.startsWith("ids[]="))
          .map((argument) => argument.slice("ids[]=".length));
        graphqlBatchSizes.push(ids.length);
        return {
          data: {
            nodes: ids.map((id) => ({
              id,
              number: Number(id.slice("I_issue_".length)),
              body: "",
              milestone: null,
              comments: { totalCount: 0, nodes: [] },
            })),
          },
        };
      }
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  const issues = await adapter.searchIssues();

  assert.equal(issues.length, 101);
  assert.deepEqual(graphqlBatchSizes, [25, 25, 25, 25, 1]);
});

test("a failed issue detail batch stops new batches and waits for started work", async () => {
  const records = Array.from({ length: 600 }, (_, index) => ({
    id: `I_issue_${index + 1}`,
    number: index + 1,
    title: `Issue ${index + 1}`,
    url: `https://github.com/acme/repo/issues/${index + 1}`,
    repository: { nameWithOwner: "acme/repo" },
    updatedAt: "2026-08-26T00:00:00Z",
    createdAt: "2026-08-26T00:00:00Z",
    author: { login: "author" },
    state: "open",
    labels: [],
    assignees: [{ login: "local-owner" }],
  }));
  let releaseStartedBatches;
  const startedBatchesMayFinish = new Promise((resolve) => {
    releaseStartedBatches = resolve;
  });
  const startedBatchIds = [];
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "search") return records;
      const ids = args
        .filter((argument) => argument.startsWith("ids[]="))
        .map((argument) => argument.slice("ids[]=".length));
      startedBatchIds.push(ids[0]);
      if (ids[0] === "I_issue_1") throw new Error("detail batch failed");
      await startedBatchesMayFinish;
      return {
        data: {
          nodes: ids.map((id) => ({
            id,
            number: Number(id.slice("I_issue_".length)),
            body: "",
            milestone: null,
            comments: { totalCount: 0, nodes: [] },
          })),
        },
      };
    },
  });

  let rejected = false;
  const search = adapter.searchIssues().catch((error) => {
    rejected = true;
    throw error;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(startedBatchIds, ["I_issue_1", "I_issue_26", "I_issue_51", "I_issue_76"]);
  assert.equal(rejected, false);
  releaseStartedBatches();
  await assert.rejects(search, /detail batch failed/);
  assert.equal(startedBatchIds.length, 4);
});

test("a GitHub refresh cannot continue command work after shutdown abort", async () => {
  const controller = new AbortController();
  const shutdown = new Error("lifecycle shutdown");
  const calls = [];
  const adapter = new GitHubAdapter({
    async run(_command, args, options) {
      calls.push(args);
      assert.strictEqual(options.signal, controller.signal);
      if (args[0] === "api") {
        controller.abort(shutdown);
        return { login: "runtime-user" };
      }
      options.signal.throwIfAborted();
      return [];
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests({ signal: controller.signal }),
    (error) => error === shutdown,
  );
  assert.equal(calls.filter((args) => args[0] === "pr").length, 0);
});

test("relevant PR search uses the active account, returns every result, and fetches detail once", async () => {
  const calls = [];
  const own = {
    number: 7,
    title: "Own PR",
    url: "https://github.com/acme/repo/pull/7",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "runtime-user" },
    state: "open",
  };
  const assigned = {
    number: 8,
    title: "Review PR",
    url: "https://github.com/acme/repo/pull/8",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "someone-else" },
    state: "open",
  };
  const run = async (_command, args) => {
    calls.push(args);
    if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args, (number) => ({ number, url: `https://github.com/acme/repo/pull/${number}`, headRefName: `feature-${number}`, headRefOid: `${number}`.repeat(40), headRepository: { nameWithOwner: "acme/repo" } }));
    if (args[0] === "api") return { login: "runtime-user" };
    if (args[0] === "search" && args.includes("--assignee=@me")) {
      return [own, assigned];
    }
    if (args[0] === "search" && args.includes("--author=@me")) return [own];
    if (args[0] === "search" && args.includes("--review-requested=@me")) return [assigned];
    if (args[0] === "pr") {
      const suffix = args[2].endsWith("/7") ? "7" : "8";
      return {
        number: Number(suffix),
        url: `https://github.com/acme/repo/pull/${suffix}`,
        baseRefName: "main",
        baseRefOid: "a".repeat(40),
        headRefName: `feature-${suffix}`,
        headRefOid: suffix.repeat(40),
        headRepository: { id: "R_kgDOExample", name: "repo" },
        headRepositoryOwner: {
          id: "U_kgDOExample",
          name: "Acme",
          login: "acme",
        },
        reviews: [],
        assignees: [{ login: 'runtime-user' }],
        labels: [],
        statusCheckRollup: [],
      };
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };

  const items = await new GitHubAdapter({ run }).searchRelevantPullRequests();

  assert.equal(items.length, 2);
  assert.deepEqual(
    calls.filter((args) => args[0] === "api" && args.at(-1) === "user"),
    [
      ["api", "--hostname", "github.com", "user"],
      ["api", "--hostname", "github.com", "user"],
    ],
  );
  assert.equal(calls.filter((args) => args[0] === "pr").length, 2);
  assert.ok(
    calls
      .filter((args) => args[0] === "search")
      .every((args) => args.includes("1000")),
  );
  assert.ok(items.every((item) => item.currentUser === "runtime-user"));
  assert.ok(items.every((item) => item.githubAccount === "runtime-user"));
  assert.ok(items.every((item) => item.baseRepository === "acme/repo"));
  assert.ok(items.every((item) => item.baseRefName === "main"));
  assert.ok(items.every((item) => item.headRepository === "acme/repo"));
  assert.ok(items.every((item) => item.gitTarget?.provider === "github"));
  assert.ok(
    items.every(
      (item) => item.gitTarget.headRefOid === item.headRefOid,
    ),
  );
  assert.ok(items.every((item) => item.reviewFactsAvailable));
});

test("relevant PR search uses the live base Ref instead of historical CLI and PR scalars", async () => {
  const record = {
    number: 42,
    title: "Resolve conflict",
    url: "https://github.com/acme/repo/pull/42",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "contributor" },
    state: "open",
  };
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args, (number) => ({
        number, url: `https://github.com/acme/repo/pull/${number}`,
        baseRefOid: "d".repeat(40),
        baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: "a".repeat(40) } },
      }));
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search" && args.includes("--assignee=@me")) {
        return [record];
      }
      if (args[0] === "search") return [];
      if (args[0] === "pr") {
        return {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          reviewDecision: "CHANGES_REQUESTED",
          statusCheckRollup: [],
          mergeStateStatus: "CLEAN",
          isDraft: false,
          labels: [],
          assignees: [{ login: 'runtime-user' }],
          milestone: null,
          baseRefName: "main",
          baseRefOid: "d".repeat(40),
          headRefName: "fix/conflict",
          headRefOid: "b".repeat(40),
          headRepository: { id: "R_kgDOExample", name: "repo" },
          headRepositoryOwner: {
            id: "U_kgDOExample",
            name: "Contributor",
            login: "contributor",
          },
          reviews: [],
        };
      }
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  const [item] = await adapter.searchRelevantPullRequests();

  assert.equal(item.gitTargetAvailable, true);
  assert.deepEqual(item.gitTarget, {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: "b".repeat(40),
  });
});

test("discovery reads current PR targets in bounded batches of 25", async () => {
  const records = Array.from({ length: 101 }, (_, index) => ({
    number: index + 1,
    title: `PR ${index + 1}`,
    url: `https://github.com/acme/repo/pull/${index + 1}`,
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "contributor" },
    state: "open",
  }));
  const batchSizes = [];
  let detailCalls = 0;
  const adapter = new GitHubAdapter({ run: async (_command, args) => {
    if (isCurrentTargetBatchCall(args)) {
      const response = currentTargetBatchResponse(args);
      batchSizes.push(Object.keys(response.data).length);
      return response;
    }
    if (args[0] === "api") return { login: "runtime-user" };
    if (args[0] === "search") return args.includes("--assignee=@me") ? records : [];
    if (args[0] === "pr") {
      detailCalls += 1;
      const number = Number(args[2].split("/").at(-1));
      return { ...currentTargetPr({ number, url: `https://github.com/acme/repo/pull/${number}` }),
        headRepository: { name: "repo" }, headRepositoryOwner: { login: "contributor" },
        reviews: [], assignees: [{ login: 'runtime-user' }], labels: [], statusCheckRollup: [],
      };
    }
    assert.fail(`Unexpected command: ${args.join(" ")}`);
  } });

  const items = await adapter.searchRelevantPullRequests();

  assert.equal(items.length, 101);
  assert.deepEqual(batchSizes, [25, 25, 25, 25, 1]);
  assert.equal(detailCalls, 101);
  assert.ok(items.every((item) => item.gitTargetAvailable && item.gitTarget.baseRefOid === "a".repeat(40)));
});

test("a partial PR detail failure makes the source stale instead of returning mixed facts", async () => {
  const record = {
    number: 8,
    title: "Review PR",
    url: "https://github.com/acme/repo/pull/8",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "someone-else" },
    state: "open",
  };
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args);
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search" && args.includes("--assignee=@me")) {
        return [record];
      }
      if (args[0] === "search") return [];
      if (args[0] === "pr") throw new Error("detail unavailable");
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests(),
    /detail unavailable/,
  );
});

test("a deleted live Ref disables only that PR while healthy discovery keeps its current target", async () => {
  const record = {
    number: 8,
    title: "Deleted fork PR",
    url: "https://github.com/acme/repo/pull/8",
    repository: { nameWithOwner: "acme/repo" },
    author: { login: "someone-else" },
    state: "open",
  };
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args, (number) => ({
        number, url: `https://github.com/acme/repo/pull/${number}`,
        ...(number === 8 ? { headRef: null, headRepository: null } : {}),
      }));
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search" && args.includes("--assignee=@me")) {
        return [record, { ...record, number: 9, url: "https://github.com/acme/repo/pull/9" }];
      }
      if (args[0] === "search") return [];
      const number = Number(args[2].split("/").at(-1));
      return {
        number,
        url: `https://github.com/acme/repo/pull/${number}`,
        baseRefName: "main",
        baseRefOid: "a".repeat(40),
        headRefName: "fix/conflict",
        headRefOid: "b".repeat(40),
        headRepository: number === 8 ? null : { name: "repo", nameWithOwner: "contributor/repo" },
        headRepositoryOwner: number === 8 ? null : { login: "contributor" },
        reviews: [],
        assignees: [{ login: 'runtime-user' }],
        labels: [],
        statusCheckRollup: [],
      };
    },
  });

  const [unavailable, healthy] = await adapter.searchRelevantPullRequests();
  assert.equal(unavailable.number, 8);
  assert.equal(unavailable.gitTargetAvailable, false);
  assert.equal(Object.hasOwn(unavailable, "gitTarget"), false);
  assert.equal(healthy.number, 9);
  assert.equal(healthy.gitTargetAvailable, true);
  assert.equal(healthy.gitTarget.baseRefOid, "a".repeat(40));
  await assert.rejects(adapter.loadReviewContext(unavailable), { code: "PR_CONTEXT_STALE" });
});

test("stale open search results enrich terminal PRs with deleted refs without executable targets", async () => {
  for (const state of ["CLOSED", "MERGED"]) {
    const record = { number: 42, title: "Finished PR", url: "https://github.com/acme/repo/pull/42",
      repository: { nameWithOwner: "acme/repo" }, author: { login: "contributor" }, state: "open" };
    const adapter = new GitHubAdapter({ run: async (_command, args) => {
      if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args, () => ({
        state, baseRef: null, headRef: null, headRepository: null,
      }));
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search") return args.includes("--assignee=@me") ? [record] : [];
      if (args[0] === "pr") return { number: 42, url: record.url, headRefOid: "b".repeat(40),
        headRepository: null, reviews: [], assignees: [{ login: 'runtime-user' }], labels: [], statusCheckRollup: [] };
      assert.fail("unexpected terminal enrichment request");
    } });
    const [item] = await adapter.searchRelevantPullRequests();
    assert.equal(item.state, state.toLowerCase());
    assert.equal(item.gitTargetAvailable, false);
    assert.equal(Object.hasOwn(item, "gitTarget"), false);
  }
});

test("an account switch during discovery invalidates the entire PR batch", async () => {
  let accountCalls = 0;
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "api") {
        accountCalls += 1;
        return { login: accountCalls === 1 ? "runtime-user" : "other-user" };
      }
      if (args[0] === "search") return [];
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests(),
    /account changed during PR refresh/,
  );
  assert.equal(accountCalls, 2);
});

test("review context is head-pinned and truncates oversized patches", async () => {
  const jsonCalls = [];
  const textCalls = [];
  let viewCount = 0;
  const run = async (_command, args) => {
    jsonCalls.push(args);
    viewCount += 1;
    if (viewCount === 1) {
      return {
        title: "Checkout fix",
        body: "Handle declined payments",
        headRefOid: "head-42",
        additions: 12,
        deletions: 3,
        changedFiles: 1,
        files: [{ path: "src/pay.js", additions: 12, deletions: 3 }],
      };
    }
    return { headRefOid: "head-42" };
  };
  const runText = async (_command, args) => {
    textCalls.push(args);
    return "0123456789abcdefghijklmnopqrstuvwxyz";
  };
  const adapter = new GitHubAdapter({ run, runText, maxPatchCharacters: 20 });

  const result = await adapter.loadReviewContext({
    id: "github:pr:acme/repo#42",
    repo: "acme/repo",
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    relation: "review_requested",
    headRefOid: "head-42",
    ciStatus: "SUCCESS",
    mergeStateStatus: "CLEAN",
  });

  assert.equal(result.headRefOid, "head-42");
  assert.equal(result.description, "Handle declined payments");
  assert.equal(result.patch, "0123456789abcdefghij");
  assert.equal(result.patchTruncated, true);
  assert.deepEqual(result.files, [
    { path: "src/pay.js", additions: 12, deletions: 3 },
  ]);
  assert.equal(jsonCalls.length, 2);
  assert.deepEqual(textCalls[0].slice(0, 3), ["pr", "diff", result.url]);
});

test("review context reports a head change instead of returning mixed evidence", async () => {
  let viewCount = 0;
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "api") return { login: "runtime-user" };
      viewCount += 1;
      return viewCount === 1
        ? { headRefOid: "head-42", files: [] }
        : { headRefOid: "head-43" };
    },
    runText: async () => "diff",
  });

  const result = await adapter.loadReviewContext({
    id: "github:pr:acme/repo#42",
    url: "https://github.com/acme/repo/pull/42",
    headRefOid: "head-42",
  });

  assert.equal(result.headRefOid, "head-43");
  assert.equal(result.patch, "");
  assert.equal(result.patchTruncated, false);
});

test("review context drops a patch when the base target changes under the same Head", async () => {
  const headRefOid = "b".repeat(40);
  let viewCount = 0;
  let targetCalls = 0;
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetCall(args)) return currentTargetResponse({ baseRefOid: (++targetCalls === 1 ? "a" : "c").repeat(40) });
      if (args[0] === "api") return { login: "runtime-user" };
      viewCount += 1;
      return viewCount === 1
        ? {
            number: 42,
            url: "https://github.com/acme/repo/pull/42",
            baseRefName: "main",
            baseRefOid: "a".repeat(40),
            headRefName: "fix/conflict",
            headRefOid,
            headRepository: { id: "R_kgDOExample", name: "repo" },
            headRepositoryOwner: {
              id: "U_kgDOExample",
              name: "Contributor",
              login: "contributor",
            },
            files: [],
          }
        : {
            number: 42,
            url: "https://github.com/acme/repo/pull/42",
            baseRefName: "main",
            baseRefOid: "c".repeat(40),
            headRefName: "fix/conflict",
            headRefOid,
            headRepository: { id: "R_kgDOExample", name: "repo" },
            headRepositoryOwner: {
              id: "U_kgDOExample",
              name: "Contributor",
              login: "contributor",
            },
          };
    },
    runText: async () => "diff that is now stale",
  });

  const request = {
    id: "github:pr:acme/repo#42",
    repo: "acme/repo",
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    gitTargetAvailable: true,
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "runtime-user",
      baseRepository: "acme/repo",
      baseRefName: "main",
      baseRefOid: "a".repeat(40),
      headRepository: "contributor/repo",
      headRefName: "fix/conflict",
      headRefOid,
    },
  };

  await assert.rejects(
    adapter.loadReviewContext(request),
    (error) => error.code === "PR_CONTEXT_STALE",
  );
});

test("review context drops a patch when the observing GitHub account changes", async () => {
  const headRefOid = "b".repeat(40);
  let accountCalls = 0;
  const metadata = {
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRefName: "fix/conflict",
    headRefOid,
    headRepository: { id: "R_kgDOExample", name: "repo" },
    headRepositoryOwner: {
      id: "U_kgDOExample",
      name: "Contributor",
      login: "contributor",
    },
    files: [],
  };
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetCall(args)) return currentTargetResponse();
      if (args[0] === "api") {
        accountCalls += 1;
        return { login: accountCalls === 1 ? "runtime-user" : "other-user" };
      }
      return metadata;
    },
    runText: async () => "diff read before the account switched",
  });

  const request = {
    id: "github:pr:acme/repo#42",
    repo: "acme/repo",
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
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
      headRefName: "fix/conflict",
      headRefOid,
    },
  };

  await assert.rejects(
    adapter.loadReviewContext(request),
    (error) => error.code === "PR_CONTEXT_STALE",
  );
  assert.equal(accountCalls, 2);
});

test("target-aware review context reads an immutable compare by the sealed OIDs", async () => {
  const baseRefOid = "a".repeat(40);
  const headRefOid = "b".repeat(40);
  const target = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid,
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid,
  };
  const textCalls = [];
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetCall(args)) return currentTargetResponse({ baseRefOid: "d".repeat(40), baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: baseRefOid } } });
      if (args[0] === "api") return { login: "runtime-user" };
      return {
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        title: "Resolve conflict",
        baseRefName: "main",
        baseRefOid: "d".repeat(40),
        headRefName: "fix/conflict",
        headRefOid,
        headRepository: { id: "R_kgDOExample", name: "repo" },
        headRepositoryOwner: {
          id: "U_kgDOExample",
          name: "Contributor",
          login: "contributor",
        },
        files: [],
      };
    },
    runText: async (_command, args) => {
      textCalls.push(args);
      return "sealed diff";
    },
  });

  const result = await adapter.loadReviewContext({
    id: "github:pr:acme/repo#42",
    repo: "acme/repo",
    number: 42,
    url: "https://github.com/acme/repo/pull/42",
    gitTargetAvailable: true,
    gitTarget: target,
  });

  assert.equal(result.patch, "sealed diff");
  assert.deepEqual(textCalls[0], [
    "api",
    "--hostname",
    "github.com",
    `repos/acme/repo/compare/${baseRefOid}...${headRefOid}`,
    "--header",
    "Accept: application/vnd.github.patch",
  ]);
});

test("a base Ref that moved before context loading prevents the sealed patch read", async () => {
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetCall(args)) return currentTargetResponse({
        baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: "c".repeat(40) } },
      });
      if (args[0] === "api") return { login: "runtime-user" };
      return { ...currentTargetPr(), files: [] };
    },
    runText: async () => assert.fail("a moved live base must not download the old patch"),
  });
  await assert.rejects(adapter.loadReviewContext({
    repo: "acme/repo", number: 42, url: "https://github.com/acme/repo/pull/42",
    gitTargetAvailable: true,
    gitTarget: { schemaVersion: 1, provider: "github", sourceAccountId: "runtime-user",
      baseRepository: "acme/repo", baseRefName: "main", baseRefOid: "a".repeat(40),
      headRepository: "contributor/repo", headRefName: "fix/conflict", headRefOid: "b".repeat(40),
    },
  }), (error) => error.code === "PR_CONTEXT_STALE");
});

test("discovery cannot mix current Ref observations with changed detail identity", async () => {
  const record = { number: 42, title: "Changed Head", url: "https://github.com/acme/repo/pull/42",
    repository: { nameWithOwner: "acme/repo" }, author: { login: "contributor" }, state: "open" };
  const adapter = new GitHubAdapter({ run: async (_command, args) => {
    if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args);
    if (args[0] === "api") return { login: "runtime-user" };
    if (args[0] === "search") return args.includes("--assignee=@me") ? [record] : [];
    return { ...currentTargetPr({ headRefOid: "c".repeat(40) }), reviews: [], labels: [], assignees: [], statusCheckRollup: [] };
  } });
  await assert.rejects(adapter.searchRelevantPullRequests(),
    (error) => error.code === "GITHUB_CURRENT_PR_TARGET_INVALID");
});

test("an explicitly unavailable live target cannot fall back to legacy patch review", async () => {
  const adapter = new GitHubAdapter({
    run: async () => assert.fail("unavailable target must fail before I/O"),
    runText: async () => assert.fail("unavailable target must not read a patch"),
  });

  await assert.rejects(
    adapter.loadReviewContext({
      id: "github:pr:acme/repo#42",
      repo: "acme/repo",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      headRefOid: "b".repeat(40),
      gitTargetAvailable: false,
    }),
    (error) => error.code === "PR_CONTEXT_STALE",
  );
});

test("target-aware no-patch context verifies the target and account twice", async () => {
  const baseRefOid = "a".repeat(40);
  const headRefOid = "b".repeat(40);
  let accountCalls = 0;
  let viewCalls = 0;
  let targetCalls = 0;
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetCall(args)) {
        targetCalls += 1;
        return currentTargetResponse({ headRefName: "fix/ci", headRepository: { nameWithOwner: "acme/repo" } });
      }
      if (args[0] === "api") {
        accountCalls += 1;
        return { login: "runtime-user" };
      }
      viewCalls += 1;
      return {
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        state: "OPEN",
        title: "Fix CI",
        baseRefName: "main",
        baseRefOid,
        headRefName: "fix/ci",
        headRefOid,
        headRepository: { id: "R_kgDOExample", name: "repo" },
        headRepositoryOwner: {
          id: "U_kgDOExample",
          name: "Acme",
          login: "acme",
        },
        files: [],
      };
    },
    runText: async () => assert.fail("patch must not be read"),
  });

  const result = await adapter.loadReviewContext(
    {
      id: "github:pr:acme/repo#42",
      repo: "acme/repo",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      headRefOid,
      gitTargetAvailable: true,
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid,
        headRepository: "acme/repo",
        headRefName: "fix/ci",
        headRefOid,
      },
    },
    { includePatch: false },
  );

  assert.equal(result.patch, "");
  assert.equal(accountCalls, 2);
  assert.equal(viewCalls, 1);
  assert.equal(targetCalls, 2);
});

test("a canonical base repository change invalidates target-aware context", async () => {
  const baseRefOid = "a".repeat(40);
  const headRefOid = "b".repeat(40);
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetCall(args)) return currentTargetResponse();
      if (args[0] === "api") return { login: "runtime-user" };
      return {
        number: 42,
        url: "https://github.com/acme/renamed/pull/42",
        baseRefName: "main",
        baseRefOid,
        headRefName: "fix/conflict",
        headRefOid,
        headRepository: { id: "R_kgDOExample", name: "repo" },
        headRepositoryOwner: {
          id: "U_kgDOExample",
          name: "Contributor",
          login: "contributor",
        },
        files: [],
      };
    },
    runText: async () => assert.fail("stale target must not read a patch"),
  });

  await assert.rejects(
    adapter.loadReviewContext({
      id: "github:pr:acme/repo#42",
      repo: "acme/repo",
      number: 42,
      url: "https://github.com/acme/repo/pull/42",
      headRefOid,
      gitTargetAvailable: true,
      gitTarget: {
        schemaVersion: 1,
        provider: "github",
        sourceAccountId: "runtime-user",
        baseRepository: "acme/repo",
        baseRefName: "main",
        baseRefOid,
        headRepository: "contributor/repo",
        headRefName: "fix/conflict",
        headRefOid,
      },
    }),
    (error) => error.code === "PR_CONTEXT_STALE",
  );
});

test("owner work can load structured PR context without downloading the patch", async () => {
  let textCalls = 0;
  const adapter = new GitHubAdapter({
    run: async () => ({
      title: "Fix CI",
      body: "Repair the failing check",
      headRefOid: "head-42",
      files: [{ path: "test/pay.test.js", additions: 2, deletions: 0 }],
    }),
    runText: async () => {
      textCalls += 1;
      return "should not be read";
    },
  });

  const result = await adapter.loadReviewContext(
    {
      id: "github:pr:acme/repo#42",
      url: "https://github.com/acme/repo/pull/42",
      headRefOid: "head-42",
    },
    { includePatch: false },
  );

  assert.equal(textCalls, 0);
  assert.equal(result.patch, "");
  assert.equal(result.patchTruncated, false);
  assert.deepEqual(result.files, [
    { path: "test/pay.test.js", additions: 2, deletions: 0 },
  ]);
});

test("an owner-selected PR target is resolved twice against one GitHub account", async () => {
  const headRefOid = "a".repeat(40);
  const baseRefOid = "b".repeat(40);
  let viewCalls = 0;
  let targetCalls = 0;
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetCall(args)) { targetCalls += 1; return currentTargetResponse({ baseRefOid: "d".repeat(40), baseRef: { name: "main", repository: { nameWithOwner: "acme/repo" }, target: { oid: baseRefOid } }, headRefOid, headRefName: "fix/ci" }); }
      if (args[0] === "api") return { login: "Runtime-User" };
      viewCalls += 1;
      return {
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        state: "OPEN",
        title: "Fix CI",
        body: "Repair the failing check",
        baseRefName: "main",
        baseRefOid: "d".repeat(40),
        headRefName: "fix/ci",
        headRefOid,
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "contributor" },
        files: [],
      };
    },
  });

  const result = await adapter.resolvePullRequestTarget({
    repository: "acme/repo",
    number: 42,
  });

  assert.equal(viewCalls, 1);
  assert.equal(targetCalls, 2);
  assert.equal(result.title, "Fix CI");
  assert.equal(result.state, "open");
  assert.deepEqual(result.gitTarget, {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid,
    headRepository: "contributor/repo",
    headRefName: "fix/ci",
    headRefOid,
  });
});

test("an owner-selected PR target fails closed when its Head changes during resolution", async () => {
  let viewCalls = 0;
  let targetCalls = 0;
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetCall(args)) return currentTargetResponse({ baseRefOid: "b".repeat(40), headRefName: "fix/ci", headRefOid: (++targetCalls === 1 ? "a" : "c").repeat(40) });
      if (args[0] === "api") return { login: "runtime-user" };
      viewCalls += 1;
      return {
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        state: "OPEN",
        title: "Fix CI",
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        headRefName: "fix/ci",
        headRefOid: (viewCalls === 1 ? "a" : "c").repeat(40),
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "contributor" },
        files: [],
      };
    },
  });

  await assert.rejects(
    adapter.resolvePullRequestTarget({ repository: "acme/repo", number: 42 }),
    (error) => error.code === "PR_CONTEXT_STALE",
  );
});

for (const state of ["CLOSED", "MERGED"]) {
  test(`an owner-selected ${state.toLowerCase()} PR fails closed`, async () => {
    const adapter = new GitHubAdapter({
      run: async (_command, args) => {
        if (isCurrentTargetCall(args)) return currentTargetResponse({ state, baseRefOid: "b".repeat(40), headRefName: "fix/inactive", headRefOid: "a".repeat(40) });
        if (args[0] === "api") return { login: "runtime-user" };
        return {
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          state,
          title: "Inactive PR",
          baseRefName: "main",
          baseRefOid: "b".repeat(40),
          headRefName: "fix/inactive",
          headRefOid: "a".repeat(40),
          headRepository: { name: "repo" },
          headRepositoryOwner: { login: "contributor" },
          files: [],
        };
      },
    });

    await assert.rejects(
      adapter.resolvePullRequestTarget({ repository: "acme/repo", number: 42 }),
      (error) => error.code === "PR_CONTEXT_STALE",
    );
  });
}

test("an owner-selected PR fails closed when it closes during resolution", async () => {
  let viewCalls = 0;
  let targetCalls = 0;
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (isCurrentTargetCall(args)) return currentTargetResponse({ state: ++targetCalls === 1 ? "OPEN" : "CLOSED", baseRefOid: "b".repeat(40), headRefName: "fix/closing", headRefOid: "a".repeat(40) });
      if (args[0] === "api") return { login: "runtime-user" };
      viewCalls += 1;
      return {
        number: 42,
        url: "https://github.com/acme/repo/pull/42",
        state: viewCalls === 1 ? "OPEN" : "CLOSED",
        title: "Closing PR",
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        headRefName: "fix/closing",
        headRefOid: "a".repeat(40),
        headRepository: { name: "repo" },
        headRepositoryOwner: { login: "contributor" },
        files: [],
      };
    },
  });

  await assert.rejects(
    adapter.resolvePullRequestTarget({ repository: "acme/repo", number: 42 }),
    (error) => error.code === "PR_CONTEXT_STALE",
  );
  assert.equal(viewCalls, 1);
  assert.equal(targetCalls, 2);
});

test("versions paginate milestones and retain the most recently active work", async () => {
  const calls = [];
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      calls.push(args);
      if (args[1].includes("milestones")) {
        return [
          [
            {
              number: 3,
              title: "Inactive but recently updated",
              created_at: "2026-07-20T00:00:00Z",
              updated_at: "2026-08-24T00:00:00Z",
              due_on: "2026-09-01T00:00:00Z",
              open_issues: 0,
              closed_issues: 5,
              html_url: "https://example.invalid/m3",
            },
          ],
          [
            {
              number: 42,
              title: "Current milestone",
              created_at: "2026-08-20T00:00:00Z",
              updated_at: "2026-08-23T00:00:00Z",
              due_on: null,
              open_issues: 2,
              closed_issues: 1,
              html_url: "https://example.invalid/m42",
            },
          ],
        ];
      }
      return [
        {
          id: 9,
          name: "v9",
          tag_name: "v9",
          created_at: "2026-07-22T00:00:00Z",
          published_at: "2026-07-23T00:00:00Z",
          html_url: "https://example.invalid/v9",
        },
      ];
    },
  });

  const versions = await adapter.versions(["acme/repo"]);

  const milestoneCall = calls.find((args) => args[1].includes("milestones"));
  assert.ok(milestoneCall[1].includes("per_page=100"));
  assert.ok(milestoneCall.includes("--paginate"));
  assert.ok(milestoneCall.includes("--slurp"));
  assert.equal(
    versions.find((version) => version.type === "milestone").title,
    "Current milestone",
  );
  assert.equal(
    versions.find((version) => version.type === "milestone").createdAt,
    "2026-08-20T00:00:00Z",
  );
  assert.equal(
    versions.find((version) => version.type === "release").createdAt,
    "2026-07-22T00:00:00Z",
  );
});

test("a partial version API failure cannot erase previously tracked records", async () => {
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[1].includes("milestones")) return [];
      throw new Error("release API unavailable");
    },
  });

  await assert.rejects(
    adapter.versions(["acme/repo"]),
    /only partially refreshed/,
  );
});
