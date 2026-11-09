import assert from "node:assert/strict";
import test from "node:test";

import {
  createPullRequestReadFacts,
  createPullRequestReadIdentity,
  normalizePullRequestReadFacts,
  projectPullRequestReadFactsContext,
  projectPullRequestReadFactsSummary,
  pullRequestReadFactsMatch,
  pullRequestReadFactsMatchExecution,
  samePullRequestReadIdentity,
} from "../src/domain/pull-request-read-facts.js";
import { createPullRequestExecutionBinding } from "../src/domain/pull-request-execution-binding.js";
import { normalizeWorkflowEvent } from "../src/domain/workflow-events.js";

const BASE_OID = "a".repeat(40);
const HEAD_OID = "b".repeat(40);
const SHA256 = "c".repeat(64);

function identityFixture({
  scopeId = "github-account:runtime-user",
  headRefOid = HEAD_OID,
  inputRevision = 4,
  ownerRequested = false,
  internalReview = false,
} = {}) {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: BASE_OID,
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid,
  };
  const event = normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: internalReview ? "pull_request.internal_review_requested" : ownerRequested
      ? "pull_request.owner_requested"
      : "pull_request.observed",
    occurredAt: "2026-08-08T01:00:00.000Z",
    source: internalReview ? { provider: "internal-review-repair", scopeId: "internal-review:12345678-1234-4123-8123-123456789abc" } : ownerRequested
      ? {
          provider: "local-owner",
          scopeId: "owner-request:12345678-1234-4123-8123-123456789abc",
        }
      : { provider: "github", scopeId },
    subject: {
      id: "github:pr:acme/repo#42",
      repository: "acme/repo",
      number: 42,
    },
    payload: {
      headRefOid,
      gitTargetAvailable: true,
      gitTarget,
      ...(internalReview ? { workType: "pull_request", state: "open", internalReview: {
        kind: "own_pr_repair", headRefOid, feedbackDigest: SHA256,
        publicationConfirmationId: "owner-publication-1", controlledCommitEvidenceId: "controlled-commit-1",
      } } : {}),
    },
  });
  const sourceBinding = {
    kind: "pull_request",
    rootItemId: "github:pr:acme/repo#42",
    workKey: "root",
    inputRevision,
    headRevision: inputRevision,
    headRefOid,
    eventId: event.eventId,
    eventDigest: event.contentDigest,
    inputDigest: SHA256,
  };
  const executionBinding = createPullRequestExecutionBinding({
    sourceBinding,
    event,
  });
  return {
    event,
    executionBinding,
    identity: createPullRequestReadIdentity({ executionBinding, event }),
  };
}

function factsFixture(identity = identityFixture().identity) {
  return createPullRequestReadFacts({
    identity,
    observedAt: "2026-08-08T01:01:00.000Z",
    reviewDecision: "CHANGES_REQUESTED",
    comments: [
      {
        id: "IC_comment_1",
        author: "author",
        body: "Please keep the compatibility path.",
        bodyTruncated: false,
        createdAt: "2026-08-08T00:30:00.000Z",
        updatedAt: "2026-08-08T00:31:00.000Z",
        url: "https://github.com/acme/repo/pull/42#issuecomment-1",
      },
    ],
    reviews: [
      {
        id: "PRR_review_1",
        author: "reviewer",
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-08-08T00:40:00.000Z",
        commitOid: HEAD_OID,
        body: "One blocking issue.",
        bodyTruncated: false,
        url: "https://github.com/acme/repo/pull/42#pullrequestreview-1",
      },
    ],
    reviewThreads: [
      {
        id: "PRRT_thread_1",
        path: "src/index.js",
        line: 12,
        originalLine: 10,
        resolved: false,
        outdated: false,
        comments: [
          {
            id: "PRRC_comment_2",
            author: "reviewer",
            body: "This can race.",
            bodyTruncated: false,
            createdAt: "2026-08-08T00:41:00.000Z",
            updatedAt: "2026-08-08T00:41:00.000Z",
            url: "https://github.com/acme/repo/pull/42#discussion_r2",
            reviewId: "PRR_review_1",
            reviewState: "CHANGES_REQUESTED",
            reviewSubmittedAt: "2026-08-08T00:40:00.000Z",
            reviewCommitOid: HEAD_OID,
          },
        ],
        commentsTruncated: false,
      },
    ],
    checks: [
      {
        kind: "check_run",
        name: "unit",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        url: "https://github.com/acme/repo/actions/runs/1",
        startedAt: "2026-08-08T00:20:00.000Z",
        completedAt: "2026-08-08T00:25:00.000Z",
        requirement: "required",
      },
    ],
    truncation: {
      comments: false,
      reviews: false,
      reviewThreads: false,
      checks: false,
      byteBudget: false,
    },
  });
}

function factInput(facts, overrides = {}) {
  return {
    identity: facts.identity,
    observedAt: facts.observedAt,
    reviewDecision: facts.reviewDecision,
    comments: facts.comments,
    reviews: facts.reviews,
    reviewThreads: facts.reviewThreads,
    checks: facts.checks,
    truncation: facts.truncation,
    ...overrides,
  };
}

test("read facts form a frozen JSON-roundtrippable persistence contract", () => {
  const facts = factsFixture();
  const roundTrip = normalizePullRequestReadFacts(
    JSON.parse(JSON.stringify(facts)),
  );

  assert.deepEqual(roundTrip, facts);
  assert.match(facts.contentDigest, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(facts), true);
  assert.equal(Object.isFrozen(facts.identity.executionBinding.gitTarget), true);
  assert.equal(Object.isFrozen(facts.reviewThreads[0].comments[0]), true);
});

test("complete material proof survives observation refresh and covers hidden context tails", () => {
  const facts = factsFixture();
  const longComments = facts.comments.map((comment) => ({ ...comment, body: "x".repeat(3_000) }));
  const original = createPullRequestReadFacts(factInput(facts, { comments: longComments }));
  const refreshed = createPullRequestReadFacts(factInput(original, { observedAt: "2026-08-08T01:20:00.000Z" }));
  const oldContext = projectPullRequestReadFactsContext(original);
  const freshContext = projectPullRequestReadFactsContext(refreshed);
  assert.notEqual(original.contentDigest, refreshed.contentDigest);
  assert.equal(oldContext.materialDigest, freshContext.materialDigest);
  assert.match(oldContext.materialDigest, /^[a-f0-9]{64}$/u);
  assert.equal(oldContext.contextTruncated, true);

  const changed = createPullRequestReadFacts(factInput(refreshed, {
    comments: longComments.map((comment) => ({ ...comment, body: `${comment.body.slice(0, -1)}y` })),
  }));
  const changedContext = projectPullRequestReadFactsContext(changed);
  assert.deepEqual(freshContext.comments, changedContext.comments);
  assert.notEqual(freshContext.materialDigest, changedContext.materialDigest);
  assert.equal(Object.hasOwn(original, "materialDigest"), false);
  assert.deepEqual(normalizePullRequestReadFacts(JSON.parse(JSON.stringify(original))), original);
});

test("incomplete source facts never issue a material proof", async (t) => {
  const base = factsFixture();
  const cases = Object.keys(base.truncation).map((name) => ({ name: `source ${name}`,
    input: { truncation: { ...base.truncation, [name]: true } } }));
  cases.push(
    { name: "comment body", input: { comments: base.comments.map((entry) => ({ ...entry, bodyTruncated: true })) } },
    { name: "review body", input: { reviews: base.reviews.map((entry) => ({ ...entry, bodyTruncated: true })) } },
    { name: "thread comments", input: { reviewThreads: base.reviewThreads.map((entry) => ({ ...entry, commentsTruncated: true })) } },
    { name: "thread body", input: { reviewThreads: base.reviewThreads.map((entry) => ({ ...entry,
      comments: entry.comments.map((comment) => ({ ...comment, bodyTruncated: true })) })) } },
  );
  for (const { name, input } of cases) {
    await t.test(name, () => {
      const context = projectPullRequestReadFactsContext(createPullRequestReadFacts(factInput(base, input)));
      assert.equal(Object.hasOwn(context, "materialDigest"), false);
    });
  }
});

test("the identity binds the exact Head and outer event/source provenance", () => {
  const first = identityFixture({ scopeId: "scope:first" });
  const otherSource = identityFixture({ scopeId: "scope:second" });
  const otherHead = identityFixture({ headRefOid: "d".repeat(40) });

  assert.equal(samePullRequestReadIdentity(first.identity, first.identity), true);
  assert.equal(
    samePullRequestReadIdentity(first.identity, otherSource.identity),
    false,
  );
  assert.equal(
    samePullRequestReadIdentity(first.identity, otherHead.identity),
    false,
  );
  assert.equal(pullRequestReadFactsMatch(factsFixture(first.identity), first.identity), true);
  assert.equal(
    pullRequestReadFactsMatch(factsFixture(first.identity), otherSource.identity),
    false,
  );
  assert.equal(
    pullRequestReadFactsMatchExecution(factsFixture(first.identity), {
      executionBinding: first.executionBinding,
      event: first.event,
    }),
    true,
  );
  assert.equal(
    pullRequestReadFactsMatchExecution(factsFixture(first.identity), {
      executionBinding: otherSource.executionBinding,
      event: otherSource.event,
    }),
    false,
  );
});

test("an owner-requested PR reads facts from its bound GitHub account", () => {
  const requested = identityFixture({ ownerRequested: true });

  assert.deepEqual(requested.identity.source, {
    provider: "github",
    scopeId: "github-account:runtime-user",
  });
  assert.equal(
    pullRequestReadFactsMatchExecution(factsFixture(requested.identity), {
      executionBinding: requested.executionBinding,
      event: requested.event,
    }),
    true,
  );
});

test("a typed internal repair review reads facts from its exact GitHub account and Head", () => {
  const requested = identityFixture({ internalReview: true });
  assert.deepEqual(requested.identity.source, { provider: "github", scopeId: "github-account:runtime-user" });
  assert.equal(pullRequestReadFactsMatchExecution(factsFixture(requested.identity), {
    executionBinding: requested.executionBinding, event: requested.event,
  }), true);
  const stale = identityFixture({ internalReview: true, headRefOid: "d".repeat(40) });
  assert.equal(samePullRequestReadIdentity(requested.identity, stale.identity), false);
  assert.throws(() => createPullRequestReadIdentity({ executionBinding: requested.executionBinding, event: stale.event }));
});

test("an execution binding cannot be paired with another event provenance", () => {
  const first = identityFixture({ scopeId: "scope:first" });
  const second = identityFixture({ scopeId: "scope:second" });

  assert.throws(
    () =>
      createPullRequestReadIdentity({
        executionBinding: first.executionBinding,
        event: second.event,
      }),
    (error) => error.code === "INVALID_PULL_REQUEST_READ_FACTS",
  );
});

test("stored facts reject digest tampering and oversized collections", () => {
  const facts = factsFixture();

  assert.throws(
    () => normalizePullRequestReadFacts({ ...facts, reviewDecision: "APPROVED" }),
    /digest/u,
  );
  assert.throws(
    () =>
      createPullRequestReadFacts({
        ...factInput(facts),
        comments: Array.from({ length: 101 }, () => facts.comments[0]),
      }),
    /comments/u,
  );
  assert.throws(
    () =>
      createPullRequestReadFacts(
        factInput(facts, {
          comments: [{ ...facts.comments[0], body: "unsafe\u0001body" }],
        }),
      ),
    /body/u,
  );
});

test("accessors and proxies are rejected without running user code", () => {
  let getterCalls = 0;
  const malicious = {};
  Object.defineProperty(malicious, "executionBinding", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return identityFixture().executionBinding;
    },
  });
  Object.defineProperty(malicious, "event", {
    enumerable: true,
    value: identityFixture().event,
  });

  assert.throws(
    () => createPullRequestReadIdentity(malicious),
    /read identity input/u,
  );
  assert.equal(getterCalls, 0);

  const proxied = new Proxy(
    { executionBinding: identityFixture().executionBinding, event: identityFixture().event },
    {
      get() {
        getterCalls += 1;
        throw new Error("must not execute");
      },
    },
  );
  assert.throws(() => createPullRequestReadIdentity(proxied));
  assert.equal(getterCalls, 0);

  const nestedEventProxy = new Proxy(identityFixture().event, {
    getPrototypeOf() {
      getterCalls += 1;
      throw new Error("must not execute");
    },
  });
  assert.throws(() =>
    createPullRequestReadIdentity({
      executionBinding: identityFixture().executionBinding,
      event: nestedEventProxy,
    })
  );
  assert.equal(getterCalls, 0);
});

test("nullable thread and lifecycle facts remain explicit", () => {
  const facts = factsFixture();
  const nullable = createPullRequestReadFacts({
    ...factInput(facts),
    reviewThreads: [
      {
        ...facts.reviewThreads[0],
        line: null,
        originalLine: null,
        resolved: null,
        outdated: null,
      },
    ],
    checks: [
      {
        ...facts.checks[0],
        status: "UNKNOWN",
        conclusion: "UNKNOWN",
        startedAt: null,
        completedAt: null,
        requirement: "unknown",
      },
    ],
  });

  assert.equal(nullable.reviewThreads[0].resolved, null);
  assert.equal(nullable.checks[0].completedAt, null);
});

test("HTTP CI details links remain visible while unsafe check URLs and HTTP discussion URLs are rejected", () => {
  const facts = factsFixture(), url = 'http://10.6.23.95:8080/job/OCT-QuickTest/1744/';
  const withJenkins = createPullRequestReadFacts(factInput(facts, { checks: [{ ...facts.checks[0], url }] }));
  assert.equal(withJenkins.checks[0].url, url);
  assert.equal(projectPullRequestReadFactsContext(withJenkins).checks[0].url, url);
  for (const unsafe of ['javascript:alert(1)', 'file:///C:/private', 'https://user:password@ci.example/job/1/']) {
    assert.throws(() => createPullRequestReadFacts(factInput(facts, { checks: [{ ...facts.checks[0], url: unsafe }] })));
  }
  assert.throws(() => createPullRequestReadFacts(factInput(facts, { comments: [{ ...facts.comments[0], url: 'http://github.com/acme/repo/issues/1' }] })));
});

test("a bounded summary projects digests and urgent facts without thread bodies", () => {
  const facts = factsFixture();
  const withUrgency = createPullRequestReadFacts(
    factInput(facts, {
      checks: [
        { ...facts.checks[0], name: "unit", conclusion: "FAILURE" },
        {
          ...facts.checks[0],
          name: "lint",
          status: "IN_PROGRESS",
          conclusion: "NONE",
        },
      ],
      truncation: { ...facts.truncation, reviews: true },
    }),
  );

  const summary = projectPullRequestReadFactsSummary(withUrgency);

  assert.deepEqual(summary, {
    schemaVersion: 1,
    identityDigest: withUrgency.identity.identityDigest,
    contentDigest: withUrgency.contentDigest,
    reviewDecision: "CHANGES_REQUESTED",
    unresolvedThreadCount: 1,
    currentUnresolvedThreadCount: 1,
    failingChecks: ["unit"],
    pendingChecks: ["lint"],
    unknownChecks: [],
    truncated: true,
  });
  assert.equal(JSON.stringify(summary).includes("This can race"), false);
  assert.equal(Object.isFrozen(summary.failingChecks), true);
});

test("a bounded task context prioritizes actionable threads and checks", () => {
  const facts = factsFixture();
  const failing = {
    ...facts.checks[0],
    name: "required-failure",
    conclusion: "FAILURE",
  };
  const context = projectPullRequestReadFactsContext(
    createPullRequestReadFacts(
      factInput(facts, {
        comments: Array.from({ length: 6 }, (_, index) => ({
          ...facts.comments[0],
          id: `IC_comment_${index + 1}`,
          body: index === 5 ? "界".repeat(3_000) : `comment ${index}`,
        })),
        checks: [
          ...Array.from({ length: 22 }, (_, index) => ({
            ...facts.checks[0],
            name: `optional-success-${String(index).padStart(2, "0")}`,
            requirement: "optional",
          })),
          failing,
        ],
      }),
    ),
  );

  assert.equal(context.comments.length, 4);
  assert.equal(context.comments.at(-1).bodyTruncated, true);
  assert.equal(context.reviewThreads[0].latestComment.body, "This can race.");
  assert.equal(context.checks[0].name, "required-failure");
  assert.equal(context.checks[0].url, facts.checks[0].url, "roles retain the original CI details link");
  assert.equal(context.checks.length, 20);
  assert.equal(context.contextTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 64 * 1024);
  assert.equal(Object.isFrozen(context.reviewThreads[0]), true);
});

test("task context adaptively prunes escape-heavy facts below its byte limit", () => {
  const facts = factsFixture();
  const escapedBody = "\\\"\\\\".repeat(2_500);
  const reviewThreads = Array.from({ length: 8 }, (_, index) => ({
    ...facts.reviewThreads[0],
    id: `PRRT_escape_${index}`,
    path: `src/escape-${index}.js`,
    comments: [
      {
        ...facts.reviewThreads[0].comments[0],
        id: `PRRC_escape_${index}`,
        body: escapedBody,
        url: `https://github.com/acme/repo/pull/42#discussion_escape_${index}`,
      },
    ],
  }));
  const escapedFacts = createPullRequestReadFacts(
    factInput(facts, { reviewThreads }),
  );

  const context = projectPullRequestReadFactsContext(escapedFacts);

  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 64 * 1024);
  assert.equal(context.contextTruncated, true);
  assert.ok(context.reviewThreads.length > 0);
  assert.equal(context.reviewThreads[0].latestComment.bodyTruncated, true);
  assert.equal(Object.isFrozen(context), true);
});
