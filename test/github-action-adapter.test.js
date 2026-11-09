import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createGitHubActionExecutor,
  markerForGitHubAction,
} from "../src/adapters/github-action-adapter.js";
import {
  githubCredentialSourceError,
} from "../src/lib/github-credential-source.js";
import { ManagedProcessError } from "../src/lib/managed-process.js";
import { OperationQueue } from "../src/lib/operation-queue.js";
import { ConfirmationQueue } from "../src/services/confirmation-queue.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const BASE_HEAD = "a".repeat(40);
const GH_COMMAND =
  process.platform === "win32"
    ? "C:\\Program Files\\GitHub CLI\\gh.exe"
    : "/usr/bin/gh";
const GH_TOKEN = "github_test_token";

async function settleWithin(promise, milliseconds = 100) {
  const timeout = Symbol("timeout");
  const controller = new AbortController();
  try {
    const result = await Promise.race([
      promise,
      delay(milliseconds, timeout, { signal: controller.signal }),
    ]);
    assert.notEqual(result, timeout, "operation did not settle after cancellation");
    return result;
  } finally {
    controller.abort();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function assertLateRejectionHandled(pending) {
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    pending.reject(new Error("late verifier rejection"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
}

function createAdapter(runner, overrides = {}) {
  return createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: recordingCredentialSource(GH_TOKEN).source,
    ...overrides,
  });
}

test("constructor accepts the shared GitHub timeout boundary", () => {
  for (const timeoutMs of [1_000, 600_000]) {
    assert.doesNotThrow(() => createAdapter(new FakeRunner(), { timeoutMs }));
  }
  for (const timeoutMs of [999, 600_001]) {
    assert.throws(
      () => createAdapter(new FakeRunner(), { timeoutMs }),
      /outside the supported range/u,
    );
  }
});

test("constructor accepts only an exact frozen credential acquire port", () => {
  const source = recordingCredentialSource().source;
  assert.doesNotThrow(() => createGitHubActionExecutor({
    runner: new FakeRunner(),
    ghCommand: GH_COMMAND,
    credentialSource: source,
  }));
  assert.throws(() => createGitHubActionExecutor({
    runner: new FakeRunner(),
    ghCommand: GH_COMMAND,
    token: GH_TOKEN,
  }), /credentialSource/u);
  assert.throws(() => createGitHubActionExecutor({
    runner: new FakeRunner(),
    ghCommand: GH_COMMAND,
    credentialProvider: () => GH_TOKEN,
  }), /credentialSource/u);
  assert.throws(() => createGitHubActionExecutor({
    runner: new FakeRunner(),
    ghCommand: GH_COMMAND,
    credentialSource: { acquire: source.acquire },
  }), /credentialSource/u);
  assert.throws(() => createGitHubActionExecutor({
    runner: new FakeRunner(),
    ghCommand: GH_COMMAND,
    credentialSource: Object.freeze({
      acquire: source.acquire,
      release: () => {},
    }),
  }), /credentialSource/u);
});

function acceptingInputAuthorityVerifier() {
  return {
    calls: [],
    async verify(value) {
      this.calls.push(structuredClone(value));
      return structuredClone(value);
    },
  };
}

function reviewEnvelope(overrides = {}) {
  const action = overrides.action || {
    type: "pull_request_review",
    reviewEvent: "APPROVE",
    body: "Reviewed the error path.",
  };
  return {
    schemaVersion: 1,
    id: "confirmation-review-42",
    idempotencyKey: `confirmation-${"a".repeat(64)}`,
    kind: "github.pull-request-review",
    requestedBy: { roleId: "pr-reviewer", workItemId: "pr-work-42" },
    actor: { provider: "github", accountId: "local-owner" },
    target: {
      provider: "github",
      resourceId: "acme/command-center#42",
      version: HEAD,
    },
    action,
    displayedPayloadDigest: "b".repeat(64),
    approvalBindingDigest: "a".repeat(64),
    execution: {
      requestId: "request-approve-0001",
      attempt: 1,
      startedAt: "2026-08-02T01:00:00.000Z",
    },
    ...overrides,
    action,
  };
}

function commentEnvelope(overrides = {}) {
  return reviewEnvelope({
    kind: "github.pull-request-review",
    action: {
      type: "pull_request_review",
      reviewEvent: "COMMENT",
      body: "Please check `$PATH`, @notes.txt & the JSON {\"ok\":true}.\nSecond line.",
    },
    ...overrides,
  });
}

function workProposalEnvelope(overrides = {}) {
  const inputBinding = {
    schemaVersion: 2,
    kind: "pull_request",
    repository: "acme/command-center",
    pullRequestNumber: 42,
    rootItemId: "pr-work-42",
    workKey: "github:dashboard:oct:42",
    inputRevision: 1,
    headRevision: 1,
    headRefOid: HEAD,
    eventId: "event-review-42",
    eventDigest: "c".repeat(64),
    inputDigest: "d".repeat(64),
    gitTarget: {
      schemaVersion: 1,
      provider: "github",
      sourceAccountId: "local-owner",
      baseRepository: "acme/command-center",
      baseRefName: "main",
      baseRefOid: BASE_HEAD,
      headRepository: "contributor/command-center",
      headRefName: "fix/conflict",
      headRefOid: HEAD,
    },
  };
  return reviewEnvelope({
    kind: "github.work-proposal-review",
    action: {
      type: "pull_request_review",
      reviewEvent: "APPROVE",
      body: "Reviewed the error path.",
      inputBinding,
    },
    ...overrides,
  });
}

class FakeRunner {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async run(input) {
    this.calls.push(structuredClone(input));
    if (!this.responses.length) throw new Error("unexpected runner call");
    let response = this.responses.shift();
    if (typeof response === "function") response = await response(input);
    if (response instanceof Error) throw response;
    if (input.args.includes("graphql") && response?.number !== undefined) {
      const repo = new URL(response.url).pathname.split("/").slice(1, 3).join("/");
      const headRepo = response.headRepository?.nameWithOwner;
      response = { data: { repository: { nameWithOwner: repo, pullRequest: {
        ...response, author: { login: "contributor" }, changedFiles: 1,
        baseRef: { name: response.baseRefName, repository: { nameWithOwner: repo }, target: { oid: response.liveBaseOid ?? response.baseRefOid } },
        headRef: { name: response.headRefName, repository: { nameWithOwner: headRepo }, target: { oid: response.headRefOid } },
      } } } };
    }
    const stdout = response?.__jsonLines
      ? response.__jsonLines.map((value) => JSON.stringify(value)).join("\n")
      : JSON.stringify(response);
    return {
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      durationMs: 1,
      truncated: false,
    };
  }
}

function recordingCredentialSource(token = "fictional_review_token") {
  const calls = {
    acquire: [],
    use: 0,
    release: 0,
  };
  const source = Object.freeze({
    async acquire(request) {
      calls.acquire.push(request);
      return Object.freeze({
        async use(callback) {
          calls.use += 1;
          return callback(token);
        },
        release() {
          calls.release += 1;
        },
      });
    },
  });
  return { calls, source, token };
}

function actor(login = "local-owner") {
  return { login };
}

function head(value = HEAD) {
  return { headRefOid: value };
}

function pages(records = []) {
  return { __jsonLines: records };
}

function pullRequestIssue(assignees = []) {
  return {
    number: 42,
    html_url: "https://github.com/acme/command-center/pull/42",
    state: "open",
    assignees: assignees.map((login) => ({ login })),
  };
}

function markerFromPost(call) {
  const body = JSON.parse(call.input).body;
  return body.match(/<!-- mydashboard-action:v1:([a-f0-9]{64}) -->$/)?.[0];
}

function commentReviewRecord(marker, overrides = {}) {
  return {
    id: 9001,
    html_url: "https://github.com/acme/command-center/pull/42#pullrequestreview-9001",
    submitted_at: "2026-08-02T01:00:01Z",
    user: { login: "local-owner" },
    body: `Please check.\n\n${marker}`,
    state: "COMMENTED",
    commit_id: HEAD,
    ...overrides,
  };
}

function reviewRecord(marker, overrides = {}) {
  return {
    id: 8001,
    html_url: "https://github.com/acme/command-center/pull/42#pullrequestreview-8001",
    submitted_at: "2026-08-02T01:00:01Z",
    user: { login: "local-owner" },
    body: `Reviewed the error path.\n\n${marker}`,
    state: "APPROVED",
    commit_id: HEAD,
    ...overrides,
  };
}

test("invalid action envelopes fail before the GitHub CLI can run", async () => {
  const invalid = [
    { ...reviewEnvelope(), extra: true },
    reviewEnvelope({ target: { provider: "github", resourceId: "not-a-pr", version: HEAD } }),
    reviewEnvelope({ target: { provider: "github", resourceId: "owner/repo#42", version: "head" } }),
    reviewEnvelope({ actor: { provider: "github", accountId: "bad login" } }),
    reviewEnvelope({ action: { type: "pull_request_review", reviewEvent: "DISMISS", body: "no" } }),
    reviewEnvelope({
      kind: "github.pull-request-comment",
      action: { type: "issue_comment", body: "legacy comment" },
    }),
    commentEnvelope({
      action: { type: "pull_request_review", reviewEvent: "COMMENT", body: "" },
    }),
    reviewEnvelope({ idempotencyKey: `confirmation-${"c".repeat(64)}` }),
  ];

  for (const envelope of invalid) {
    const runner = new FakeRunner();
    const result = await createAdapter(runner).execute(envelope);
    assert.deepEqual(result, {
      status: "error",
      error: { trust: "trusted", code: "INVALID_GITHUB_ACTION" },
    });
    assert.equal(runner.calls.length, 0);
  }
});

test("the configured actor is checked before target or marker queries", async () => {
  const runner = new FakeRunner([actor("different-user")]);
  const result = await createAdapter(runner).reconcile(reviewEnvelope());

  assert.deepEqual(result, {
    status: "error",
    error: { trust: "trusted", code: "GITHUB_ACTOR_MISMATCH" },
  });
  assert.deepEqual(runner.calls.map((call) => call.args), [
    ["api", "--hostname", "github.com", "--method", "GET", "user"],
  ]);
});

test("a confirmed testing handoff adds its named GitHub assignee idempotently", async () => {
  const runner = new FakeRunner([
    actor(),
    pullRequestIssue(["local-owner"]),
    actor(),
    pullRequestIssue(["local-owner", "qt-tester"]),
    actor(),
    pullRequestIssue(["qt-tester"]),
  ]);
  const adapter = createAdapter(runner);
  const request = {
    actorAccountId: "local-owner",
    repository: "acme/command-center",
    pullRequestNumber: 42,
    assigneeLogin: "qt-tester",
  };

  assert.deepEqual(await adapter.assignAssignee(request), {
    status: "applied",
    assigneeLogin: "qt-tester",
  });
  const post = runner.calls.find((call) => call.args.includes("POST"));
  assert.deepEqual(post.args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "repos/acme/command-center/issues/42/assignees",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(post.input), {
    assignees: ["qt-tester"],
  });
  const remove = runner.calls.find((call) => call.args.includes("DELETE"));
  assert.deepEqual(remove.args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "DELETE",
    "repos/acme/command-center/issues/42/assignees",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(remove.input), {
    assignees: ["local-owner"],
  });

  const already = createAdapter(new FakeRunner([
    actor(),
    pullRequestIssue(["QT-TESTER"]),
  ]));
  assert.deepEqual(await already.assignAssignee(request), {
    status: "already",
    assigneeLogin: "qt-tester",
  });

  const partialRetry = createAdapter(new FakeRunner([
    actor(),
    pullRequestIssue(["local-owner", "qt-tester"]),
    actor(),
    pullRequestIssue(["qt-tester"]),
  ]));
  assert.deepEqual(await partialRetry.assignAssignee(request), {
    status: "applied",
    assigneeLogin: "qt-tester",
  });
});

test("every published automatic Review assigns its next owner before removing the reviewer", async (t) => {
  for (const [reviewEvent, assigneeLogin] of [["APPROVE", "qt-tester"], ["REQUEST_CHANGES", "developer"], ["COMMENT", "developer"]]) {
    await t.test(reviewEvent, async () => {
      const request = {
        actorAccountId: "local-owner", repository: "acme/command-center", pullRequestNumber: 42,
        headRefOid: HEAD, reviewEvent, testingOwnerLogin: reviewEvent === "APPROVE" ? "qt-tester" : null,
      };
      const runner = new FakeRunner([
        actor(), { number: 42, state: "open", html_url: "https://github.com/acme/command-center/pull/42", head: { sha: HEAD }, user: { login: "developer" } },
        actor(), pullRequestIssue(["local-owner", "other-owner"]),
        { head: { sha: HEAD }, state: "open" }, actor(), pullRequestIssue(["local-owner", "other-owner", assigneeLogin]),
        { head: { sha: HEAD }, state: "open" }, actor(), pullRequestIssue(["other-owner", assigneeLogin]),
      ]);
      assert.equal((await createAdapter(runner).assignReviewOutcome(request)).assigneeLogin, assigneeLogin);
      const writes = runner.calls.filter((call) => call.args.includes("POST") || call.args.includes("DELETE"));
      assert.equal(writes.length, 2);
      assert.ok(writes[0].args.includes("POST"));
      assert.deepEqual(JSON.parse(writes[0].input), { assignees: [assigneeLogin] });
      assert.ok(writes[1].args.includes("DELETE"));
      assert.deepEqual(JSON.parse(writes[1].input), { assignees: ["local-owner"] });
    });
  }
});

test("automatic Review handoff refuses a changed Head", async () => {
  const request = { actorAccountId: "local-owner", repository: "acme/command-center", pullRequestNumber: 42, headRefOid: HEAD, reviewEvent: "REQUEST_CHANGES", testingOwnerLogin: null };
  const changed = new FakeRunner([actor(), { number: 42, state: "open", html_url: "https://github.com/acme/command-center/pull/42", head: { sha: OTHER_HEAD }, user: { login: "developer" } }]);
  await assert.rejects(createAdapter(changed).assignReviewOutcome(request), { code: "GITHUB_HANDOFF_HEAD_CHANGED" });
  assert.equal(changed.calls.some((call) => call.args.includes("POST")), false);
});

test("a failed next-owner assignment never removes the reviewer", async () => {
  const runner = new FakeRunner([
    actor(), pullRequestIssue(["local-owner"]), actor(),
    pullRequestIssue(["local-owner"]),
  ]);
  await assert.rejects(createAdapter(runner).assignAssignee({
    actorAccountId: "local-owner", repository: "acme/command-center",
    pullRequestNumber: 42, assigneeLogin: "developer",
  }), { code: "GITHUB_PROTOCOL" });
  assert.equal(runner.calls.some((call) => call.args.includes("DELETE")), false);
});

test("automatic publication rechecks its scope immediately before POST", async () => {
  const envelope = workProposalEnvelope();
  envelope.execution.requestId = `auto-review-v1-${"a".repeat(48)}`;
  const target = { number: 42, url: "https://github.com/acme/command-center/pull/42", state: "OPEN", baseRefName: "main", baseRefOid: BASE_HEAD, headRefName: "fix/conflict", headRefOid: HEAD, headRepository: { nameWithOwner: "contributor/command-center" } };
  for (const guard of [null, { verify: async () => false }]) {
    const runner = new FakeRunner([actor(), pages([]), target, actor(), target]);
    const adapter = createAdapter(runner, { inputAuthorityVerifier: { verify: async (binding) => binding }, automaticReviewGuard: guard });
    assert.equal((await adapter.execute(envelope)).status, "stale");
    assert.equal(runner.calls.some((call) => call.args.includes("POST")), false);
  }
});

test("work proposal reviews use the same sealed GitHub review protocol", async () => {
  const runner = new FakeRunner([actor("different-user")]);
  const result = await createAdapter(runner).reconcile(
    workProposalEnvelope(),
  );

  assert.deepEqual(result, {
    status: "error",
    error: { trust: "trusted", code: "GITHUB_ACTOR_MISMATCH" },
  });
  assert.equal(runner.calls.length, 1);
});

test("work proposal reviews verify the full sealed Git target at execution time", async () => {
  const currentTarget = {
    number: 42,
    url: "https://github.com/acme/command-center/pull/42",
    state: "OPEN",
    baseRefName: "main",
    baseRefOid: "d".repeat(40),
    liveBaseOid: BASE_HEAD,
    headRefName: "fix/conflict",
    headRefOid: HEAD,
    headRepository: { nameWithOwner: "contributor/command-center" },
  };
  const matchingVerifier = acceptingInputAuthorityVerifier();
  const matching = new FakeRunner([actor(), pages([]), currentTarget]);
  assert.deepEqual(
    await createAdapter(matching, {
      inputAuthorityVerifier: matchingVerifier,
    }).reconcile(workProposalEnvelope()),
    { status: "absent", code: "GITHUB_MARKER_ABSENT" },
  );
  assert.equal(matchingVerifier.calls.length, 1);
  assert.equal(matching.calls[2].args.includes("graphql"), true);
  assert.match(matching.calls[2].args.find((arg) => arg.startsWith("query=")), /baseRef \{ name repository \{ nameWithOwner \} target/);

  const changedBase = new FakeRunner([
    actor(),
    pages([]),
    { ...currentTarget, liveBaseOid: "e".repeat(40) },
  ]);
  assert.deepEqual(
    await createAdapter(changedBase, {
      inputAuthorityVerifier: acceptingInputAuthorityVerifier(),
    }).reconcile(workProposalEnvelope()),
    { status: "stale", expectedVersion: HEAD, actualVersion: HEAD },
  );
});

test("work proposal execution rechecks ledger authority and the full target before POST", async () => {
  const currentTarget = {
    number: 42,
    url: "https://github.com/acme/command-center/pull/42",
    state: "OPEN",
    baseRefName: "main",
    baseRefOid: BASE_HEAD,
    headRefName: "fix/conflict",
    headRefOid: HEAD,
    headRepository: { nameWithOwner: "contributor/command-center" },
  };
  const verifier = acceptingInputAuthorityVerifier();
  const runner = new FakeRunner([
    actor(),
    pages([]),
    currentTarget,
    actor(),
    currentTarget,
    (call) => reviewRecord(markerFromPost(call)),
  ]);

  const result = await createAdapter(runner, {
    inputAuthorityVerifier: verifier,
  }).execute(workProposalEnvelope());

  assert.equal(result.status, "applied");
  assert.equal(verifier.calls.length, 2);
  assert.equal(runner.calls.at(-1).args.includes("POST"), true);
  assert.equal(JSON.parse(runner.calls.at(-1).input).commit_id, HEAD);

  const changedBase = new FakeRunner([
    actor(),
    pages([]),
    currentTarget,
    actor(),
    { ...currentTarget, liveBaseOid: "e".repeat(40) },
  ]);
  const stale = await createAdapter(changedBase, {
    inputAuthorityVerifier: acceptingInputAuthorityVerifier(),
  }).execute(workProposalEnvelope());
  assert.deepEqual(stale, {
    status: "stale",
    expectedVersion: HEAD,
    actualVersion: HEAD,
  });
  assert.equal(changedBase.calls.some((call) => call.args.includes("POST")), false);
});

test("work proposal review execution becomes stale if the PR closes before POST", async () => {
  const openTarget = {
    number: 42,
    url: "https://github.com/acme/command-center/pull/42",
    state: "OPEN",
    baseRefName: "main",
    baseRefOid: BASE_HEAD,
    headRefName: "fix/conflict",
    headRefOid: HEAD,
    headRepository: { nameWithOwner: "contributor/command-center" },
  };
  const runner = new FakeRunner([
    actor(),
    pages([]),
    openTarget,
    actor(),
    { ...openTarget, state: "CLOSED" },
  ]);

  assert.deepEqual(
    await createAdapter(runner, {
      inputAuthorityVerifier: acceptingInputAuthorityVerifier(),
    }).execute(workProposalEnvelope()),
    { status: "stale", expectedVersion: HEAD, actualVersion: HEAD },
  );
  assert.equal(runner.calls.some((call) => call.args.includes("POST")), false);
});

test("revoked work proposal authority prevents every GitHub call", async () => {
  let verifierCalls = 0;
  const runner = new FakeRunner();
  const result = await createAdapter(runner, {
    inputAuthorityVerifier: {
      async verify() {
        verifierCalls += 1;
        throw new Error("authority revoked");
      },
    },
  }).execute(workProposalEnvelope());

  assert.deepEqual(result, { status: "stale" });
  assert.equal(verifierCalls, 1);
  assert.equal(runner.calls.length, 0);
});

test("unavailable historical assignment facts remain retryable at execution and unknown at reconciliation", async () => {
  for (const method of ["execute", "reconcile"]) {
    const runner = new FakeRunner(method === "reconcile" ? [actor(), pages([])] : []);
    const adapter = createAdapter(runner, { inputAuthorityVerifier: { async verify() {
      throw Object.assign(new Error("Assignment lookup unavailable"), { code: "OWNER_REVIEW_ASSIGNMENT_UNAVAILABLE" });
    } } });
    assert.deepEqual(await adapter[method](workProposalEnvelope()), { status: "error",
      error: { trust: method === "execute" ? "absent" : "unknown", code: "GITHUB_UNAVAILABLE" } });
    assert.equal(runner.calls.some(call => call.args.includes("POST")), false);
  }
});

test("legacy work-proposal actions are reconcile-only and cannot be retried", async () => {
  const legacy = reviewEnvelope({ kind: "github.work-proposal-review" });
  const executeRunner = new FakeRunner();
  assert.deepEqual(await createAdapter(executeRunner).execute(legacy), {
    status: "error",
    error: { trust: "trusted", code: "INVALID_GITHUB_ACTION" },
  });
  assert.equal(executeRunner.calls.length, 0);

  const reconcileRunner = new FakeRunner([actor(), pages([])]);
  assert.deepEqual(await createAdapter(reconcileRunner).reconcile(legacy), {
    status: "stale",
  });
  assert.equal(reconcileRunner.calls.length, 2);
});

test("every GitHub call uses one fixed token, absolute executable, and minimal environment", async () => {
  const sourceEnv = {
    GH_TOKEN: "token_from_parent",
    PATH: "C:\\untrusted-bin",
    DATABASE_URL: "postgres://must-not-reach-child",
    SystemRoot: "C:\\Windows",
    HTTPS_PROXY: "http://127.0.0.1:8080",
  };
  const credential = recordingCredentialSource(
    "fixed_token_for_confirmed_account",
  );
  const runner = new FakeRunner([actor(), pages([]), head()]);
  const adapter = createAdapter(runner, {
    credentialSource: credential.source,
    environment: sourceEnv,
    networkEnv: { HTTPS_PROXY: sourceEnv.HTTPS_PROXY },
  });
  sourceEnv.GH_TOKEN = "changed_after_construction";

  assert.deepEqual(await adapter.reconcile(reviewEnvelope()), {
    status: "absent",
    code: "GITHUB_MARKER_ABSENT",
  });
  for (const call of runner.calls) {
    assert.equal(call.command, GH_COMMAND);
    assert.deepEqual(call.env, {
      GH_TOKEN: "fixed_token_for_confirmed_account",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "http://127.0.0.1:8080",
    });
    assert.equal("PATH" in call.env, false);
    assert.equal("DATABASE_URL" in call.env, false);
  }
});

test("credentials are acquired only when an action runs and absence makes no GitHub call", async () => {
  let reads = 0;
  const runner = new FakeRunner();
  const adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: Object.freeze({
      async acquire() {
        reads += 1;
        throw githubCredentialSourceError("GITHUB_CREDENTIAL_MISSING");
      },
    }),
  });

  assert.equal(reads, 0);
  assert.deepEqual(await adapter.reconcile(reviewEnvelope()), {
    status: "error",
    error: { code: "GITHUB_CREDENTIAL_MISSING", trust: "absent" },
  });
  assert.equal(reads, 1);
  assert.equal(runner.calls.length, 0);
});

test("one Review execution seals one leased credential across every GitHub call", async () => {
  const credential = recordingCredentialSource("operation_token_1");
  const runner = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    (input) => {
      const marker = markerFromPost(input);
      return reviewRecord(marker, {
        body: `${reviewEnvelope().action.body}\n\n${marker}`,
      });
    },
  ]);
  const adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: credential.source,
    environment: { SystemRoot: "C:\\Windows" },
  });

  assert.equal((await adapter.execute(reviewEnvelope())).status, "applied");
  assert.equal(credential.calls.acquire.length, 1);
  assert.equal(runner.calls.length, 6);
  for (const call of runner.calls) {
    assert.equal(call.env.GH_TOKEN, "operation_token_1");
  }
});

test("one Review execution acquires, uses, and releases one actor-bound lease", async () => {
  const credential = recordingCredentialSource();
  const runner = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    (input) => {
      const marker = markerFromPost(input);
      return reviewRecord(marker, {
        body: `${reviewEnvelope().action.body}\n\n${marker}`,
      });
    },
  ]);
  const adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: credential.source,
    environment: { SystemRoot: "C:\\Windows" },
    clock: () => 1_000_000,
    timeoutMs: 60_000,
  });

  const result = await adapter.execute(reviewEnvelope());

  assert.equal(result.status, "applied");
  assert.deepEqual(credential.calls.acquire, [{
    actorAccountId: "local-owner",
    signal: credential.calls.acquire[0].signal,
    deadline: 1_060_000,
  }]);
  assert.equal(credential.calls.acquire[0].signal instanceof AbortSignal, true);
  assert.equal(credential.calls.use, 1);
  assert.equal(credential.calls.release, 1);
  assert.equal(runner.calls.length, 6);
  for (const call of runner.calls) {
    assert.equal(call.env.GH_TOKEN, credential.token);
  }
  assert.equal(JSON.stringify(result).includes(credential.token), false);
});

test("one Review reconcile acquires, uses, and releases one actor-bound lease", async () => {
  const credential = recordingCredentialSource();
  const runner = new FakeRunner([actor(), pages([]), head()]);
  const adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: credential.source,
    clock: () => 2_000_000,
    timeoutMs: 60_000,
  });

  const result = await adapter.reconcile(reviewEnvelope());

  assert.deepEqual(result, { status: "absent", code: "GITHUB_MARKER_ABSENT" });
  assert.equal(credential.calls.acquire.length, 1);
  assert.equal(credential.calls.acquire[0].actorAccountId, "local-owner");
  assert.equal(credential.calls.acquire[0].deadline, 2_060_000);
  assert.equal(credential.calls.acquire[0].signal instanceof AbortSignal, true);
  assert.equal(credential.calls.use, 1);
  assert.equal(credential.calls.release, 1);
});

test("closing the Review executor cancels the active lease and prevents later calls", async () => {
  const credential = recordingCredentialSource();
  let adapter;
  const runner = new FakeRunner([
    async () => {
      await adapter.close();
      return actor();
    },
  ]);
  adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: credential.source,
  });

  const result = await adapter.execute(reviewEnvelope());

  assert.deepEqual(result, {
    status: "error",
    error: { trust: "absent", code: "GITHUB_UNAVAILABLE" },
  });
  assert.equal(runner.calls.length, 1);
  assert.equal(credential.calls.use, 1);
  assert.equal(credential.calls.release, 1);
  assert.equal(credential.calls.acquire[0].signal.aborted, true);
});

test("closing Review bounds a hanging authority verifier before credentials", async () => {
  const started = deferred();
  const pending = deferred();
  const credential = recordingCredentialSource();
  const runner = new FakeRunner();
  const adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: credential.source,
    inputAuthorityVerifier: {
      async verify() {
        started.resolve();
        return pending.promise;
      },
    },
  });

  const execution = adapter.execute(workProposalEnvelope());
  await started.promise;
  adapter.close();

  assert.deepEqual(await settleWithin(execution), {
    status: "error",
    error: { trust: "absent", code: "GITHUB_UNAVAILABLE" },
  });
  assert.equal(credential.calls.acquire.length, 0);
  assert.equal(runner.calls.length, 0);
  await assertLateRejectionHandled(pending);
});

test("Review deadline bounds a hanging authority recheck and releases its lease", async (t) => {
  let now = 4_000_000;
  let operationTimer;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    operationTimer = { callback, milliseconds, unref() {} };
    return operationTimer;
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const started = deferred();
  const pending = deferred();
  let checks = 0;
  const binding = workProposalEnvelope().action.inputBinding;
  const credential = recordingCredentialSource();
  const runner = new FakeRunner([
    actor(),
    pages([]),
    {
      number: 42,
      url: "https://github.com/acme/command-center/pull/42",
      state: "OPEN",
      baseRefName: "main",
      baseRefOid: BASE_HEAD,
      headRefName: "fix/conflict",
      headRefOid: HEAD,
      headRepository: { nameWithOwner: "contributor/command-center" },
    },
    actor(),
    {
      number: 42,
      url: "https://github.com/acme/command-center/pull/42",
      state: "OPEN",
      baseRefName: "main",
      baseRefOid: BASE_HEAD,
      headRefName: "fix/conflict",
      headRefOid: HEAD,
      headRepository: { nameWithOwner: "contributor/command-center" },
    },
  ]);
  const adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: credential.source,
    inputAuthorityVerifier: {
      async verify() {
        checks += 1;
        if (checks === 1) return structuredClone(binding);
        started.resolve();
        return pending.promise;
      },
    },
    clock: () => now,
    timeoutMs: 1_000,
  });

  const execution = adapter.execute(workProposalEnvelope());
  await started.promise;
  now = 4_001_000;
  operationTimer.callback();

  assert.deepEqual(await settleWithin(execution), {
    status: "error",
    error: { trust: "absent", code: "GITHUB_TIMEOUT" },
  });
  assert.equal(runner.calls.length, 5);
  assert.equal(runner.calls.some((call) => call.args.includes("POST")), false);
  assert.equal(credential.calls.release, 1);
  await assertLateRejectionHandled(pending);
});

test("Review authority checks and subprocesses share one decreasing total deadline", async () => {
  let now = 3_000_000;
  const credential = recordingCredentialSource();
  const verifier = acceptingInputAuthorityVerifier();
  verifier.verify = async function verify(value) {
    this.calls.push(structuredClone(value));
    now += 5_000;
    return structuredClone(value);
  };
  const runner = new FakeRunner([
    actor(),
    pages([]),
    {
      number: 42,
      url: "https://github.com/acme/command-center/pull/42",
      state: "OPEN",
      baseRefName: "main",
      baseRefOid: BASE_HEAD,
      headRefName: "fix/conflict",
      headRefOid: HEAD,
      headRepository: { nameWithOwner: "contributor/command-center" },
    },
    actor(),
    {
      number: 42,
      url: "https://github.com/acme/command-center/pull/42",
      state: "OPEN",
      baseRefName: "main",
      baseRefOid: BASE_HEAD,
      headRefName: "fix/conflict",
      headRefOid: HEAD,
      headRepository: { nameWithOwner: "contributor/command-center" },
    },
    (input) => reviewRecord(markerFromPost(input)),
  ]);
  const adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: credential.source,
    clock: () => now,
    timeoutMs: 60_000,
    inputAuthorityVerifier: verifier,
  });

  assert.equal((await adapter.execute(workProposalEnvelope())).status, "applied");
  assert.equal(credential.calls.acquire[0].deadline, 3_060_000);
  assert.deepEqual(
    runner.calls.map((call) => call.timeoutMs),
    [55_000, 55_000, 55_000, 55_000, 55_000, 50_000],
  );
});

test("Review leases release after already, stale, mismatch, timeout, and callback failure", async (t) => {
  const marker = markerForGitHubAction(reviewEnvelope());
  const cases = [
    { name: "already", responses: [actor(), pages([reviewRecord(marker)])] },
    { name: "actor mismatch", responses: [actor("other-owner")] },
    { name: "target mismatch", responses: [actor(), pages([]), head(OTHER_HEAD)] },
    {
      name: "transport timeout",
      responses: [new ManagedProcessError("PROCESS_TIMEOUT", "timed out")],
    },
    { name: "callback failure", responses: [new Error("callback failed")] },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const credential = recordingCredentialSource();
      const adapter = createGitHubActionExecutor({
        runner: new FakeRunner(entry.responses),
        ghCommand: GH_COMMAND,
        credentialSource: credential.source,
      });

      await adapter.reconcile(reviewEnvelope());

      assert.equal(credential.calls.acquire.length, 1);
      assert.equal(credential.calls.use, 1);
      assert.equal(credential.calls.release, 1);
    });
  }
});

test("credential cleanup uncertainty blocks every Review consumer call", async () => {
  const canary = "fictional_cleanup_canary_742";
  const runner = new FakeRunner();
  const adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: Object.freeze({
      async acquire() {
        throw githubCredentialSourceError("GITHUB_CREDENTIAL_CLEANUP_FAILED");
      },
    }),
  });

  const result = await adapter.execute(reviewEnvelope());

  assert.deepEqual(result, {
    status: "error",
    error: { trust: "unknown", code: "GITHUB_CREDENTIAL_CLEANUP_FAILED" },
  });
  assert.equal(runner.calls.length, 0);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("Review rejects a non-exact credential lease before use or GitHub calls", async () => {
  let uses = 0;
  let releases = 0;
  const runner = new FakeRunner();
  const adapter = createGitHubActionExecutor({
    runner,
    ghCommand: GH_COMMAND,
    credentialSource: Object.freeze({
      async acquire() {
        return Object.freeze({
          async use() { uses += 1; },
          release() { releases += 1; },
          token: "fictional_smuggled_token",
        });
      },
    }),
  });

  const result = await adapter.execute(reviewEnvelope());

  assert.deepEqual(result, {
    status: "error",
    error: { trust: "absent", code: "GITHUB_CREDENTIAL_OUTPUT_INVALID" },
  });
  assert.equal(uses, 0);
  assert.equal(releases, 0);
  assert.equal(runner.calls.length, 0);
  assert.equal(JSON.stringify(result).includes("fictional_smuggled_token"), false);
});

test("reconciliation finds one exact COMMENT review marker across paginated results", async () => {
  const marker = markerForGitHubAction(commentEnvelope());
  const runner = new FakeRunner([
    actor(),
    pages([
      commentReviewRecord("<!-- mydashboard-action:v1:" + "0".repeat(64) + " -->"),
      commentReviewRecord(marker, {
        body: `${commentEnvelope().action.body}\n\n${marker}`,
      }),
    ]),
  ]);

  const result = await createAdapter(runner).reconcile(commentEnvelope());

  assert.equal(result.status, "already");
  assert.deepEqual(result.receipt, {
    id: "9001",
    url: "https://github.com/acme/command-center/pull/42",
    createdAt: "2026-08-02T01:00:01.000Z",
  });
  assert.deepEqual(runner.calls[1].args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "GET",
    "repos/acme/command-center/pulls/42/reviews?per_page=100",
    "--paginate",
    "--jq",
    `.[] | select((.body // "") | contains("${marker}")) | {id, html_url, submitted_at, user: {login: .user.login}, body, state, commit_id}`,
  ]);
});

test("copied, conflicting, or duplicate markers fail closed", async () => {
  const marker = markerForGitHubAction(reviewEnvelope());
  for (const records of [
    [reviewRecord(marker, { user: { login: "other-user" } })],
    [reviewRecord(marker, { state: "COMMENTED" })],
    [reviewRecord(marker), reviewRecord(marker, { id: 8002 })],
  ]) {
    const runner = new FakeRunner([actor(), pages(records)]);
    const result = await createAdapter(runner).reconcile(reviewEnvelope());
    assert.deepEqual(result, {
      status: "error",
      error: { trust: "unknown", code: "GITHUB_MARKER_CONFLICT" },
    });
  }
});

test("a GitHub receipt must identify the exact PR and review record", async () => {
  const marker = markerForGitHubAction(reviewEnvelope());
  for (const html_url of [
    "https://github.com/acme/command-center/pull/43#pullrequestreview-8001",
    "https://github.com/acme/command-center/pull/42#pullrequestreview-9999",
    "https://github.com/other/repo/pull/42#pullrequestreview-8001",
    "https://github.com:444/acme/command-center/pull/42#pullrequestreview-8001",
  ]) {
    const runner = new FakeRunner([
      actor(),
      pages([reviewRecord(marker, { html_url })]),
    ]);
    assert.deepEqual(
      await createAdapter(runner).reconcile(reviewEnvelope()),
      {
        status: "error",
        error: { trust: "unknown", code: "GITHUB_PROTOCOL" },
      },
    );
  }
});

test("marker reconciliation asks gh to project only matching records", async () => {
  const marker = markerForGitHubAction(reviewEnvelope());
  const runner = new FakeRunner([
    actor(),
    pages([reviewRecord(marker)]),
  ]);

  assert.equal(
    (await createAdapter(runner).reconcile(reviewEnvelope())).status,
    "already",
  );
  assert.equal(runner.calls[1].args.includes("--jq"), true);
  assert.equal(runner.calls[1].args.at(-1).includes(marker), true);
});

test("reconciliation reports absence only after marker and current head checks", async () => {
  const runner = new FakeRunner([actor(), pages([]), head()]);
  const result = await createAdapter(runner).reconcile(reviewEnvelope());

  assert.deepEqual(result, { status: "absent", code: "GITHUB_MARKER_ABSENT" });
  assert.deepEqual(runner.calls[2].args, [
    "pr",
    "view",
    "https://github.com/acme/command-center/pull/42",
    "--json",
    "headRefOid",
  ]);
});

test("a changed PR head is stale and never reaches a POST", async () => {
  const runner = new FakeRunner([actor(), pages([]), head(OTHER_HEAD)]);
  const result = await createAdapter(runner).execute(reviewEnvelope());

  assert.deepEqual(result, {
    status: "stale",
    expectedVersion: HEAD,
    actualVersion: OTHER_HEAD,
  });
  assert.equal(runner.calls.some((call) => call.args.includes("POST")), false);
});

test("COMMENT review execution keeps arbitrary body text off process argv", async () => {
  const runner = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    (input) => {
      const marker = markerFromPost(input);
      return commentReviewRecord(marker, {
        body: `${commentEnvelope().action.body}\n\n${marker}`,
      });
    },
  ]);
  const adapter = createAdapter(runner, { clock: () => 6_000_000 });
  const envelope = commentEnvelope();
  const result = await adapter.execute(envelope);
  const post = runner.calls.at(-1);
  const marker = markerFromPost(post);

  assert.equal(result.status, "applied");
  assert.deepEqual(post.args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "repos/acme/command-center/pulls/42/reviews",
    "--input",
    "-",
  ]);
  assert.equal(post.args.join(" ").includes("@notes.txt"), false);
  const payload = JSON.parse(post.input);
  assert.equal(payload.event, "COMMENT");
  assert.equal(payload.body.includes("@notes.txt &"), true);
  assert.equal(payload.commit_id, HEAD);
  assert.equal(post.command, GH_COMMAND);
  assert.equal(post.timeoutMs, 60_000);
});

test("review execution pins the exact commit and allowed event", async () => {
  const runner = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    (input) => {
      const marker = markerFromPost(input);
      return reviewRecord(marker, {
        body: `${reviewEnvelope().action.body}\n\n${marker}`,
      });
    },
  ]);
  const adapter = createAdapter(runner);
  const result = await adapter.execute(reviewEnvelope());
  const post = runner.calls.at(-1);
  const marker = markerFromPost(post);

  assert.equal(result.status, "applied");
  assert.deepEqual(post.args, [
    "api",
    "--hostname",
    "github.com",
    "--method",
    "POST",
    "repos/acme/command-center/pulls/42/reviews",
    "--input",
    "-",
  ]);
  assert.deepEqual(JSON.parse(post.input), {
    event: "APPROVE",
    body: `${reviewEnvelope().action.body}\n\n${marker}`,
    commit_id: HEAD,
  });
});

test("a second actor or head check can stop a write immediately before POST", async () => {
  for (const responses of [
    [actor(), pages([]), head(), actor("different-user")],
    [actor(), pages([]), head(), actor(), head(OTHER_HEAD)],
  ]) {
    const runner = new FakeRunner(responses);
    const result = await createAdapter(runner).execute(reviewEnvelope());
    assert.notEqual(result.status, "applied");
    assert.equal(runner.calls.some((call) => call.args.includes("POST")), false);
  }
});

test("process and protocol failures expose only stable codes", async () => {
  const secret = "ghp_must_not_escape";
  const scenarios = [
    {
      response: new ManagedProcessError("PROCESS_TIMEOUT", "timed out", {
        details: { stdout: "", stderr: secret },
      }),
      code: "GITHUB_TIMEOUT",
      trust: "absent",
    },
    {
      response: { malformed: true },
      code: "GITHUB_PROTOCOL",
      trust: "absent",
    },
  ];
  for (const scenario of scenarios) {
    const runner = new FakeRunner([scenario.response]);
    if (!(scenario.response instanceof Error)) {
      runner.run = async function run(input) {
        this.calls.push(structuredClone(input));
        return {
          exitCode: 0,
          stdout: "not-json",
          stderr: secret,
          signal: null,
          durationMs: 1,
          truncated: false,
        };
      };
    }
    const result = await createAdapter(runner).execute(reviewEnvelope());
    assert.deepEqual(result, {
      status: "error",
      error: { trust: scenario.trust, code: scenario.code },
    });
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("a transport failure becomes unknown only after the GitHub POST starts", async () => {
  const timeout = () =>
    new ManagedProcessError("PROCESS_TIMEOUT", "timed out", {
      details: { stdout: "", stderr: "private transport detail" },
    });
  const beforePost = new FakeRunner([actor(), timeout()]);
  assert.deepEqual(await createAdapter(beforePost).execute(reviewEnvelope()), {
    status: "error",
    error: { trust: "absent", code: "GITHUB_TIMEOUT" },
  });

  const duringPost = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    timeout(),
  ]);
  assert.deepEqual(await createAdapter(duringPost).execute(reviewEnvelope()), {
    status: "error",
    error: { trust: "unknown", code: "GITHUB_TIMEOUT" },
  });
  assert.equal(duringPost.calls.at(-1).args.includes("POST"), true);
});

test("approval is required before a write and repeated approval does not write twice", async () => {
  const credential = recordingCredentialSource(GH_TOKEN);
  const runner = new FakeRunner([
    actor(),
    pages([]),
    head(),
    actor(),
    head(),
    (input) => {
      const marker = markerFromPost(input);
      return reviewRecord(marker, {
        body: `Reviewed the error path.\n\n${marker}`,
      });
    },
  ]);
  const adapter = createAdapter(runner, {
    credentialSource: credential.source,
  });
  let persisted = null;
  const store = {
    async read(_name, fallback) {
      return persisted === null ? structuredClone(fallback) : structuredClone(persisted);
    },
    async write(_name, value) {
      persisted = structuredClone(value);
    },
  };
  const leaseQueue = new OperationQueue();
  const queue = new ConfirmationQueue({
    store,
    executor: adapter,
    operationQueue: new OperationQueue(),
    exclusiveLease: { run: (operation) => leaseQueue.enqueue(operation) },
    clock: (() => {
      let second = 0;
      return () => new Date(`2026-08-02T01:00:0${second++}.000Z`);
    })(),
  });
  await queue.recover();
  const envelope = reviewEnvelope();
  await queue.enqueue({
    id: envelope.id,
    kind: envelope.kind,
    requestedBy: envelope.requestedBy,
    actor: envelope.actor,
    target: {
      provider: envelope.target.provider,
      resourceId: envelope.target.resourceId,
      version: envelope.target.version,
    },
    action: envelope.action,
    display: {
      title: "发布 PR Review",
      summary: "确认后才会写入 GitHub",
      actionLabel: "确认并发布到 GitHub",
      evidence: ["当前 Head 已复核"],
      payload: {
        actor: envelope.actor,
        target: {
          provider: envelope.target.provider,
          resourceId: envelope.target.resourceId,
          version: envelope.target.version,
        },
        action: envelope.action,
      },
    },
  });
  assert.equal(runner.calls.length, 0);
  assert.equal(credential.calls.acquire.length, 0);

  await queue.next();
  await queue.list({ limit: 10 });
  await queue.get(envelope.id);
  assert.equal(credential.calls.acquire.length, 0);

  const next = await queue.next();
  const request = {
    requestId: "request-approve-0001",
    expectedQueueRevision: next.queueRevision,
    expectedItemRevision: next.item.itemRevision,
    displayedPayloadDigest: next.item.displayedPayloadDigest,
    approvalBindingDigest: next.item.approvalBindingDigest,
  };
  const completed = await queue.approve(next.item.id, request);
  assert.equal(completed.status, "completed");
  assert.equal(credential.calls.acquire.length, 1);
  assert.equal(runner.calls.filter((call) => call.args.includes("POST")).length, 1);

  await queue.approve(next.item.id, request);
  assert.equal(credential.calls.acquire.length, 1);
  assert.equal(runner.calls.filter((call) => call.args.includes("POST")).length, 1);
});

test("pending and rejected confirmations never acquire a Review credential", async () => {
  let acquisitions = 0;
  let persisted = null;
  const queue = new ConfirmationQueue({
    store: {
      async read(_name, fallback) {
        return persisted === null ? structuredClone(fallback) : structuredClone(persisted);
      },
      async write(_name, value) { persisted = structuredClone(value); },
    },
    executor: {
      async execute(envelope) {
        acquisitions += 1;
        return { status: "stale", envelope };
      },
      async reconcile(envelope) {
        acquisitions += 1;
        return { status: "stale", envelope };
      },
    },
    operationQueue: new OperationQueue(),
    exclusiveLease: { run: (operation) => operation() },
  });
  await queue.recover();
  const envelope = reviewEnvelope({ id: "confirmation-review-reject-42" });
  await queue.enqueue({
    id: envelope.id,
    kind: envelope.kind,
    requestedBy: envelope.requestedBy,
    actor: envelope.actor,
    target: envelope.target,
    action: envelope.action,
    display: {
      title: "Reject Review",
      summary: "No credential may be acquired.",
      actionLabel: "Reject",
      evidence: [],
      payload: {
        actor: envelope.actor,
        target: envelope.target,
        action: envelope.action,
      },
    },
  });
  const pending = await queue.next();

  await queue.list({ limit: 10 });
  await queue.get(envelope.id);
  await queue.reject(envelope.id, {
    requestId: "request-reject-0001",
    expectedQueueRevision: pending.queueRevision,
    expectedItemRevision: pending.item.itemRevision,
    displayedPayloadDigest: pending.item.displayedPayloadDigest,
    approvalBindingDigest: pending.item.approvalBindingDigest,
  });

  assert.equal(acquisitions, 0);
});


test("named reviewer handoff adds QA before removing the reviewer", async () => {
  const request = { actorAccountId: "local-owner", repository: "acme/command-center",
    pullRequestNumber: 42, expectedHeadOid: HEAD, expectedAssigneeLogin: "human-reviewer", assigneeLogin: "qt-tester" };
  const live = assignees => ({ ...pullRequestIssue(assignees), head: { sha: HEAD } });
  const runner = new FakeRunner([
    actor(), pullRequestIssue(["human-reviewer"]), live(["human-reviewer"]), actor(),
    pullRequestIssue(["human-reviewer", "qt-tester"]), live(["human-reviewer", "qt-tester"]), actor(),
    pullRequestIssue(["qt-tester"]),
  ]);
  assert.deepEqual(await createAdapter(runner).assignAssignee(request), { status: "applied", assigneeLogin: "qt-tester" });
  const writes = runner.calls.filter(call => call.args.includes("POST") || call.args.includes("DELETE"));
  assert.equal(writes.length, 2);
  assert.ok(writes[0].args.includes("POST"));
  assert.deepEqual(JSON.parse(writes[0].input), { assignees: ["qt-tester"] });
  assert.ok(writes[1].args.includes("DELETE"));
  assert.deepEqual(JSON.parse(writes[1].input), { assignees: ["human-reviewer"] });
  assert.equal(runner.responses.length, 0);
});

test("named reviewer handoff refuses owner or Head drift before writing", async t => {
  const request = { actorAccountId: "local-owner", repository: "acme/command-center",
    pullRequestNumber: 42, expectedHeadOid: HEAD, expectedAssigneeLogin: "human-reviewer", assigneeLogin: "qt-tester" };
  for (const [name, responses, code] of [
    ["initial owner", [actor(), pullRequestIssue(["other-owner"])], "GITHUB_HANDOFF_OWNER_CHANGED"],
    ["live owner", [actor(), pullRequestIssue(["human-reviewer"]), { ...pullRequestIssue(["other-owner"]), head: { sha: HEAD } }], "GITHUB_HANDOFF_OWNER_CHANGED"],
    ["live Head", [actor(), pullRequestIssue(["human-reviewer"]), { ...pullRequestIssue(["human-reviewer"]), head: { sha: OTHER_HEAD } }], "GITHUB_HANDOFF_HEAD_CHANGED"],
  ]) await t.test(name, async () => {
    const runner = new FakeRunner(responses);
    await assert.rejects(createAdapter(runner).assignAssignee(request), { code });
    assert.equal(runner.calls.some(call => call.args.includes("POST") || call.args.includes("DELETE")), false);
    assert.equal(runner.responses.length, 0);
  });
});

test("named reviewer handoff converges after an add succeeds but its acknowledgement is lost", async () => {
  const request = { actorAccountId: "local-owner", repository: "acme/command-center",
    pullRequestNumber: 42, expectedHeadOid: HEAD, expectedAssigneeLogin: "human-reviewer", assigneeLogin: "qt-tester" };
  const live = assignees => ({ ...pullRequestIssue(assignees), head: { sha: HEAD } });
  let owners = ["human-reviewer"];
  const first = new FakeRunner([actor(), pullRequestIssue(owners), live(owners), actor(), () => {
    owners = ["human-reviewer", "qt-tester"];
    throw new Error("assignment acknowledgement lost");
  }]);
  await assert.rejects(createAdapter(first).assignAssignee(request));
  assert.equal(first.calls.some(call => call.args.includes("DELETE")), false);
  assert.deepEqual(owners, ["human-reviewer", "qt-tester"]);
  const retry = new FakeRunner([actor(), pullRequestIssue(owners), live(owners), actor(), pullRequestIssue(["qt-tester"])]);
  assert.deepEqual(await createAdapter(retry).assignAssignee(request), { status: "applied", assigneeLogin: "qt-tester" });
  assert.equal(retry.calls.some(call => call.args.includes("POST")), false);
  const removal = retry.calls.find(call => call.args.includes("DELETE"));
  assert.deepEqual(JSON.parse(removal.input), { assignees: ["human-reviewer"] });
  assert.equal(retry.responses.length, 0);
});
