import assert from "node:assert/strict";
import test from "node:test";

import { GitHubAdapter } from "../src/adapters/github-adapter.js";
import { resolveEffectivePullRequestUpdatedWindow } from "../src/domain/pull-request-updated-window.js";

function searchRecord(number, updatedAt, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/repo/pull/${number}`,
    repository: { nameWithOwner: "acme/repo" },
    updatedAt,
    createdAt: "2026-01-01T00:00:00Z",
    author: { login: number % 2 === 0 ? "runtime-user" : "contributor" },
    state: "open",
    ...overrides,
  };
}

function detailFor(url) {
  const number = Number(url.split("/").at(-1));
  return {
    number,
    url,
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRefName: `feature-${number}`,
    headRefOid: `${number % 10}`.repeat(40),
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: "acme" },
    reviews: [],
    assignees: [{ login: 'runtime-user' }],
    labels: [],
    statusCheckRollup: [],
  };
}

function isCurrentTargetBatchCall(args) {
  return args.some((value) => value.startsWith("query=") && value.includes("MyDashboardCurrentPullRequestTargets {"));
}

function currentTargetBatchResponse(args) {
  const query = args.find((value) => value.startsWith("query="));
  const aliases = [...query.matchAll(/(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)\s*\{\s*nameWithOwner pullRequest\(number:(\d+)\)/gu)];
  assert.ok(aliases.length > 0, "current-target batch must have aliased repository selections");
  return { data: Object.fromEntries(aliases.map(([, alias, owner, name, value]) => {
    const number = Number(value);
    const repository = { nameWithOwner: `${owner}/${name}` };
    const detail = detailFor(`https://github.com/${owner}/${name}/pull/${number}`);
    return [alias, { ...repository, pullRequest: {
      ...detail,
      state: "OPEN",
      author: { login: number % 2 === 0 ? "runtime-user" : "contributor" },
      changedFiles: 1,
      headRepository: repository,
      baseRef: { name: detail.baseRefName, repository, target: { oid: detail.baseRefOid } },
      headRef: { name: detail.headRefName, repository, target: { oid: detail.headRefOid } },
    } }];
  })) };
}

function updatedArgument(args) {
  const index = args.indexOf("--updated");
  return index === -1 ? null : args[index + 1];
}

test("effective PR windows freeze one refresh instant without drifting legacy mode", () => {
  const startedAt = "2026-08-13T12:34:56.789Z";
  assert.deepEqual(resolveEffectivePullRequestUpdatedWindow(undefined, startedAt), {
    mode: "unlimited",
    refreshStartedAt: startedAt,
  });
  assert.deepEqual(
    resolveEffectivePullRequestUpdatedWindow(
      { mode: "rolling", days: 7 },
      startedAt,
    ),
    {
      mode: "rolling",
      days: 7,
      refreshStartedAt: startedAt,
      fromInclusive: "2026-08-06T12:34:56.789Z",
    },
  );
});

test("finite PR search uses official updated sorting and filters locally before details", async () => {
  const searchCalls = [];
  const detailCalls = [];
  const records = [
    searchRecord(1, "2026-08-01T00:00:00Z"),
    searchRecord(2, "2026-08-12T16:00:00Z"),
    searchRecord(3, "2026-08-12T15:59:59.999Z"),
  ];
  const run = async (_command, args) => {
    if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args);
    if (args[0] === "api") return { login: "runtime-user" };
    if (args[0] === "search") {
      searchCalls.push(args);
      return args.includes("--assignee=@me") ? records : [];
    }
    if (args[0] === "pr") {
      detailCalls.push(args[2]);
      return detailFor(args[2]);
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };
  const effectiveUpdatedWindow = resolveEffectivePullRequestUpdatedWindow(
    {
      mode: "fixed",
      fromInclusive: "2026-07-31T16:00:00.000Z",
      untilExclusive: "2026-08-12T16:00:00.000Z",
      timeZone: "Asia/Shanghai",
    },
    "2026-08-13T01:02:03.456Z",
  );

  const items = await new GitHubAdapter({ run }).searchRelevantPullRequests({
    effectiveUpdatedWindow,
  });

  assert.deepEqual(items.map(({ number }) => number), [3, 1]);
  assert.deepEqual(detailCalls.sort(), [records[0].url, records[2].url].sort());
  assert.equal(searchCalls.length, 2);
  for (const args of searchCalls) {
    assert.equal(
      updatedArgument(args),
      "2026-07-31T16:00:00+00:00..2026-08-12T16:00:00+00:00",
    );
    assert.ok(args.includes("--sort"));
    assert.equal(args[args.indexOf("--sort") + 1], "updated");
    assert.equal(args[args.indexOf("--order") + 1], "asc");
  }
});

test("a saturated PR search splits inclusive ranges and deduplicates the overlap", async () => {
  const searchCalls = [];
  const rootRange =
    "2026-08-01T00:00:00+00:00..2026-08-03T00:00:00+00:00";
  const rootRecords = Array.from({ length: 1_000 }, (_, index) =>
    searchRecord(index + 1, "2026-08-02T00:00:00Z"),
  );
  const overlap = searchRecord(42, "2026-08-02T00:00:00Z");
  const run = async (_command, args) => {
    if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args);
    if (args[0] === "api") return { login: "runtime-user" };
    if (args[0] === "search") {
      const relation = args.includes("--assignee=@me") ? "assigned" : args.includes("--author=@me") ? "authored" : "requested";
      const range = updatedArgument(args);
      searchCalls.push({ relation, range });
      if (relation !== "assigned") return [];
      if (range === rootRange) return rootRecords;
      return [overlap];
    }
    if (args[0] === "pr") return detailFor(args[2]);
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };
  const effectiveUpdatedWindow = Object.freeze({
    mode: "fixed",
    fromInclusive: "2026-08-01T00:00:00.000Z",
    untilExclusive: "2026-08-03T00:00:00.000Z",
    timeZone: "UTC",
    refreshStartedAt: "2026-08-04T00:00:00.000Z",
  });

  const items = await new GitHubAdapter({ run }).searchRelevantPullRequests({
    effectiveUpdatedWindow,
  });

  assert.deepEqual(items.map(({ number }) => number), [42]);
  assert.deepEqual(
    searchCalls.filter(({ relation }) => relation === "assigned").map(({ range }) => range),
    [
      rootRange,
      "2026-08-01T00:00:00+00:00..2026-08-02T00:00:00+00:00",
      "2026-08-02T00:00:00+00:00..2026-08-03T00:00:00+00:00",
    ],
  );
  assert.deepEqual(
    searchCalls.filter(({ relation }) => relation === "authored"),
    [{ relation: "authored", range: rootRange }],
  );
});

test("rolling PR windows include the exact millisecond lower bound and no earlier detail", async () => {
  const detailCalls = [];
  const startedAt = "2026-08-13T12:34:56.789Z";
  const effectiveUpdatedWindow = resolveEffectivePullRequestUpdatedWindow(
    { mode: "rolling", days: 7 },
    startedAt,
  );
  const records = [
    searchRecord(1, "2026-08-06T12:34:56.789Z"),
    searchRecord(2, "2026-08-06T12:34:56.788Z"),
  ];
  const ranges = [];
  const run = async (_command, args) => {
    if (isCurrentTargetBatchCall(args)) return currentTargetBatchResponse(args);
    if (args[0] === "api") return { login: "runtime-user" };
    if (args[0] === "search") {
      ranges.push(updatedArgument(args));
      return args.includes("--assignee=@me") ? records : [];
    }
    if (args[0] === "pr") {
      detailCalls.push(args[2]);
      return detailFor(args[2]);
    }
    throw new Error(`Unexpected call: ${args.join(" ")}`);
  };

  const items = await new GitHubAdapter({ run }).searchRelevantPullRequests({
    effectiveUpdatedWindow,
  });

  assert.deepEqual(items.map(({ number }) => number), [1]);
  assert.deepEqual(detailCalls, [records[0].url]);
  assert.ok(
    ranges.every(
      (range) =>
        range ===
        "2026-08-06T12:34:56+00:00..2970-12-31T23:59:59+00:00",
    ),
  );
});

test("malformed finite-window search facts fail before any PR detail call", async () => {
  let detailCalls = 0;
  const malformed = searchRecord(1, "not-a-timestamp");
  const effectiveUpdatedWindow = resolveEffectivePullRequestUpdatedWindow(
    {
      mode: "fixed",
      fromInclusive: "2026-08-01T00:00:00.000Z",
      untilExclusive: "2026-08-03T00:00:00.000Z",
      timeZone: "UTC",
    },
    "2026-08-04T00:00:00.000Z",
  );
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search") {
        return args.includes("--assignee=@me") ? [malformed] : [];
      }
      if (args[0] === "pr") detailCalls += 1;
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests({ effectiveUpdatedWindow }),
    /updatedAt is invalid/u,
  );
  assert.equal(detailCalls, 0);
});

test("conflicting duplicate search identities fail the whole finite PR source", async () => {
  let detailCalls = 0;
  const effectiveUpdatedWindow = resolveEffectivePullRequestUpdatedWindow(
    {
      mode: "fixed",
      fromInclusive: "2026-08-01T00:00:00.000Z",
      untilExclusive: "2026-08-03T00:00:00.000Z",
      timeZone: "UTC",
    },
    "2026-08-04T00:00:00.000Z",
  );
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search") {
        return [
          searchRecord(
            42,
            args.includes("--assignee=@me")
              ? "2026-08-02T00:00:00Z"
              : "2026-08-02T00:00:01Z",
          ),
        ];
      }
      if (args[0] === "pr") detailCalls += 1;
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests({ effectiveUpdatedWindow }),
    /identity conflict/u,
  );
  assert.equal(detailCalls, 0);
});

test("one-second PR search saturation fails closed without detail calls", async () => {
  let detailCalls = 0;
  let searchCalls = 0;
  const effectiveUpdatedWindow = resolveEffectivePullRequestUpdatedWindow(
    {
      mode: "fixed",
      fromInclusive: "2026-08-01T00:00:00.000Z",
      untilExclusive: "2026-08-02T00:00:00.000Z",
      timeZone: "UTC",
    },
    "2026-08-03T00:00:00.000Z",
  );
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search" && args.includes("--author=@me")) return [];
      if (args[0] === "search") {
        searchCalls += 1;
        const [from, until] = updatedArgument(args).split("..");
        const midpoint = new Date(
          Math.floor((Date.parse(from) + Date.parse(until)) / 2 / 1_000) * 1_000,
        ).toISOString();
        return Array.from({ length: 1_000 }, (_, index) =>
          searchRecord(index + 1, midpoint),
        );
      }
      if (args[0] === "pr") detailCalls += 1;
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests({ effectiveUpdatedWindow }),
    /saturated within one second/u,
  );
  assert.ok(searchCalls > 1);
  assert.equal(detailCalls, 0);
});

test("conflicting records in an inclusive segment overlap fail before details", async () => {
  let detailCalls = 0;
  const effectiveUpdatedWindow = resolveEffectivePullRequestUpdatedWindow(
    {
      mode: "fixed",
      fromInclusive: "2026-08-01T00:00:00.000Z",
      untilExclusive: "2026-08-03T00:00:00.000Z",
      timeZone: "UTC",
    },
    "2026-08-04T00:00:00.000Z",
  );
  const root = Array.from({ length: 1_000 }, (_, index) =>
    searchRecord(index + 1, "2026-08-02T00:00:00Z"),
  );
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search" && args.includes("--author=@me")) return [];
      if (args[0] === "search") {
        const range = updatedArgument(args);
        if (range.includes("2026-08-01T00:00:00+00:00..2026-08-03")) return root;
        return [searchRecord(42, "2026-08-02T00:00:00Z", {
          title: range.startsWith("2026-08-01") ? "left" : "right",
          createdAt: range.startsWith("2026-08-01")
            ? "2026-01-01T00:00:00Z"
            : "2026-01-02T00:00:00Z",
        })];
      }
      if (args[0] === "pr") detailCalls += 1;
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests({ effectiveUpdatedWindow }),
    /identity conflict/u,
  );
  assert.equal(detailCalls, 0);
});

test("aborting after a saturated segment prevents every child search", async () => {
  const controller = new AbortController();
  let searchCalls = 0;
  const effectiveUpdatedWindow = resolveEffectivePullRequestUpdatedWindow(
    {
      mode: "fixed",
      fromInclusive: "2026-08-01T00:00:00.000Z",
      untilExclusive: "2026-08-03T00:00:00.000Z",
      timeZone: "UTC",
    },
    "2026-08-04T00:00:00.000Z",
  );
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search") {
        searchCalls += 1;
        controller.abort(new Error("stop segmented search"));
        return Array.from({ length: 1_000 }, (_, index) =>
          searchRecord(index + 1, "2026-08-02T00:00:00Z"),
        );
      }
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests({
      effectiveUpdatedWindow,
      signal: controller.signal,
    }),
    /stop segmented search/u,
  );
  assert.equal(searchCalls, 2);
});

test("an impossible calendar timestamp is rejected before details", async () => {
  let detailCalls = 0;
  const effectiveUpdatedWindow = resolveEffectivePullRequestUpdatedWindow(
    {
      mode: "fixed",
      fromInclusive: "2026-02-01T00:00:00.000Z",
      untilExclusive: "2026-04-01T00:00:00.000Z",
      timeZone: "UTC",
    },
    "2026-04-02T00:00:00.000Z",
  );
  const adapter = new GitHubAdapter({
    run: async (_command, args) => {
      if (args[0] === "api") return { login: "runtime-user" };
      if (args[0] === "search") {
        return args.includes("--assignee=@me")
          ? [searchRecord(1, "2026-02-30T00:00:00Z")]
          : [];
      }
      if (args[0] === "pr") detailCalls += 1;
      throw new Error(`Unexpected call: ${args.join(" ")}`);
    },
  });

  await assert.rejects(
    adapter.searchRelevantPullRequests({ effectiveUpdatedWindow }),
    /updatedAt is invalid/u,
  );
  assert.equal(detailCalls, 0);
});
