import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createGitHubPullRequestActionTransport } from "../src/adapters/github-pull-request-action-transport.js";
import { pullRequestExternalActionMarker } from "../src/domain/pull-request-external-action.js";
import { ManagedProcessError } from "../src/lib/managed-process.js";
import {
  PullRequestExternalActionTransportError,
  createPullRequestExternalActionExecutor,
} from "../src/services/pull-request-external-action-executor.js";
import {
  externalActionControlledCommit,
  externalActionOid,
  pullRequestExternalActionBinding,
  pullRequestExternalActionEnvelope,
  pullRequestExternalActionPlan,
} from "./support/pull-request-external-action-fixture.js";

const GH_COMMAND = path.resolve("test", "fixtures", "gh.exe");
const CREATED_AT = "2026-08-08T07:08:09.012Z";
const CREDENTIAL = "github-secret-never-print";
const REVIEW_STATE = Object.freeze({
  APPROVE: "APPROVED",
  REQUEST_CHANGES: "CHANGES_REQUESTED",
  COMMENT: "COMMENTED",
});

function expectedReviewEvent(input) {
  return input.actionType === "comment" ? "COMMENT" : input.action.reviewEvent;
}

function proposalAction(type, binding) {
  return {
    comment: { type, body: "Please add a regression test." },
    review: { type, verdict: "approve", body: "The change is correct." },
    update_branch: { type },
    push: {
      type,
      controlledCommitEvidence: externalActionControlledCommit(binding),
    },
    merge: { type, method: "squash" },
  }[type];
}

function transportInput(
  type,
  binding = pullRequestExternalActionBinding(),
  action = proposalAction(type, binding),
) {
  const envelope = pullRequestExternalActionEnvelope(
    pullRequestExternalActionPlan(action, { binding }),
  );
  return {
    credential: CREDENTIAL,
    actorAccountId: envelope.actor.accountId,
    repository: binding.repository,
    pullRequestNumber: binding.pullRequestNumber,
    actionType: type,
    marker: pullRequestExternalActionMarker(envelope),
    action: structuredClone(envelope.action),
  };
}

function pullRequestRecord(input, overrides = {}) {
  const target = input.action.inputBinding.gitTarget;
  const headOid = overrides.headOid ?? target.headRefOid;
  const merged = overrides.state === "merged";
  return {
    number: input.pullRequestNumber,
    user: { login: overrides.authorAccountId ?? "contributor" },
    html_url: `https://github.com/${input.repository}/pull/${input.pullRequestNumber}`,
    state: merged ? "closed" : (overrides.state ?? "open"),
    merged_at: merged ? (overrides.mergedAt ?? CREATED_AT) : null,
    merge_commit_sha: merged ? overrides.mergeCommitOid : null,
    merged_by: merged ? { login: overrides.mergedBy ?? input.actorAccountId } : null,
    base: {
      ref: target.baseRefName,
      sha: overrides.baseOid ?? target.baseRefOid,
      repo: { full_name: target.baseRepository },
    },
    head: {
      ref: target.headRefName,
      sha: headOid,
      repo: { full_name: target.headRepository },
    },
  };
}

function markerRecord(input, { kind, id, body, state, commitId } = {}) {
  const fragment = kind === "review" ? "pullrequestreview" : "issuecomment";
  return {
    id,
    html_url:
      `https://github.com/${input.repository}/pull/${input.pullRequestNumber}#${fragment}-${id}`,
    created_at: CREATED_AT,
    submitted_at: CREATED_AT,
    user: { login: input.actorAccountId },
    body,
    ...(state === undefined ? {} : { state }),
    ...(commitId === undefined ? {} : { commit_id: commitId }),
  };
}

function mergeProofBody(input, mergeCommitOid) {
  return `MyDashboard controlled merge proof\n\n${input.marker}\n\n${JSON.stringify({
    schemaVersion: 1,
    actorAccountId: input.actorAccountId,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    expectedHeadOid: input.action.expectedHeadOid,
    method: input.action.method,
    mergeCommitOid,
  })}`;
}

class FakeRunner {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async run(options) {
    this.calls.push({
      ...structuredClone(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (this.responses.length === 0) {
      throw new Error("unexpected gh call");
    }
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    let value = typeof next === "function" ? await next(options) : next;
    if (options.args.includes("graphql") && value?.number !== undefined) value = {
      data: { repository: { nameWithOwner: value.base?.repo?.full_name, pullRequest: {
        number: value.number, url: value.html_url, state: value.merged_at ? "MERGED" : String(value.state).toUpperCase(),
        author: value.user, changedFiles: 1, mergedAt: value.merged_at,
        mergeCommit: value.merge_commit_sha ? { oid: value.merge_commit_sha } : null, mergedBy: value.merged_by,
        baseRefName: value.base?.ref, baseRefOid: value.base?.sha,
        baseRef: { name: value.base?.ref, repository: { nameWithOwner: value.base?.repo?.full_name }, target: { oid: value.base?.liveSha ?? value.base?.sha } },
        headRefName: value.head?.ref, headRefOid: value.head?.sha,
        headRef: value.headRefDeleted === true ? null : { name: value.head?.ref, repository: { nameWithOwner: value.head?.repo?.full_name }, target: { oid: value.head?.sha } },
        headRepository: { nameWithOwner: value.head?.repo?.full_name },
      } } },
    };
    if (value?.processResult === true) return value.value;
    return {
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify(value),
      stderr: "",
      durationMs: 1,
      truncated: false,
    };
  }
}

function actionTransport(runner, options = {}) {
  return createGitHubPullRequestActionTransport({
    runner,
    ghCommand: GH_COMMAND,
    env: {
      SystemRoot: "C:\\Windows",
      PATH: "must-not-be-inherited",
      GH_TOKEN: "must-not-be-inherited",
    },
    networkEnv: { NO_PROXY: "github.com" },
    updatePollIntervalMs: 0,
    delay: async () => {},
    ...options,
  });
}

test("constructor accepts the shared GitHub timeout boundary", () => {
  for (const timeoutMs of [1_000, 600_000]) {
    assert.doesNotThrow(() => actionTransport(new FakeRunner(), { timeoutMs }));
  }
  for (const timeoutMs of [999, 600_001]) {
    assert.throws(
      () => actionTransport(new FakeRunner(), { timeoutMs }),
      /outside the supported range/u,
    );
  }
});

function actorRecord(input) {
  return { login: input.actorAccountId };
}

function operation(deadline, signal = new AbortController().signal) {
  return Object.freeze({ signal, deadline });
}

function credentialSource(token = CREDENTIAL) {
  return Object.freeze({
    async acquire() {
      return Object.freeze({
        use: (callback) => callback(token),
        release() {},
      });
    },
  });
}

function assertTransportError(code, trust) {
  return (error) =>
    error instanceof PullRequestExternalActionTransportError &&
    error.code === code &&
    error.trust === trust;
}

function assertSafeGhCalls(calls) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.command, GH_COMMAND);
    assert.deepEqual(call.args.slice(0, 7), [
      "api",
      "--hostname",
      "github.com",
      "--header",
      "Accept: application/vnd.github+json",
      "--header",
      "X-GitHub-Api-Version: 2026-03-10",
    ]);
    assert.equal(call.args.includes("--method"), true);
    assert.equal(call.env.GH_TOKEN, CREDENTIAL);
    assert.equal(call.env.GH_HOST, "github.com");
    assert.equal(call.env.GH_PROMPT_DISABLED, "1");
    assert.equal(call.env.NO_PROXY, "github.com");
    assert.equal("PATH" in call.env, false);
    assert.equal(
      JSON.stringify({
        command: call.command,
        args: call.args,
        input: call.input,
      }).includes(CREDENTIAL),
      false,
    );
  }
}

test("observes all five action kinds through fixed github.com commands", async () => {
  for (const type of ["comment", "review", "update_branch", "push", "merge"]) {
    const input = transportInput(type);
    const responses = [actorRecord(input), pullRequestRecord(input)];
    if (["comment", "review"].includes(type)) responses.push([]);
    const runner = new FakeRunner(responses);

    const observation = await actionTransport(runner).observe(input);

    assert.equal(observation.schemaVersion, 1);
    assert.equal(observation.actorAccountId, input.actorAccountId);
    assert.deepEqual(observation.gitTarget, input.action.inputBinding.gitTarget);
    assert.equal(observation.state, "open");
    assert.deepEqual(observation.actionEvidence, {
      comment: { kind: "marker_records", records: [] },
      review: { kind: "marker_records", records: [] },
      update_branch: { kind: "head_commit", commit: null },
      push: { kind: "head_ref" },
      merge: { kind: "merge_state", merge: null },
    }[type]);
    assertSafeGhCalls(runner.calls);
    assert.equal(runner.responses.length, 0);
  }
});

test("one transport operation gives each subprocess only its remaining budget", async () => {
  let now = 1_000_000;
  const input = transportInput("comment");
  const runner = new FakeRunner([
    () => { now += 5_000; return actorRecord(input); },
    () => { now += 7_000; return pullRequestRecord(input); },
    () => { now += 3_000; return []; },
  ]);
  const transport = actionTransport(runner, { clock: () => now });

  await transport.observe(input, operation(1_060_000));

  assert.deepEqual(
    runner.calls.map((call) => call.timeoutMs),
    [60_000, 55_000, 48_000],
  );
  assert.deepEqual(
    runner.calls.map((call) => ({
      hasSignal: Object.hasOwn(call, "signal"),
      isSignal: call.signal instanceof AbortSignal,
    })),
    Array.from({ length: 3 }, () => ({ hasSignal: true, isSignal: true })),
  );
});

test("an aggregate push deadline preserves the configured per-request timeout", async () => {
  const input = transportInput("push");
  const runner = new FakeRunner([actorRecord(input), pullRequestRecord(input)]);
  await actionTransport(runner, { clock: () => 1_000_000, timeoutMs: 60_000 })
    .observe(input, operation(1_600_000));
  assert.deepEqual(runner.calls.map(call => call.timeoutMs), [60_000, 60_000]);
});

test("satisfies the executor transport contract through a complete comment cycle", async () => {
  const directInput = transportInput("comment");
  const envelope = pullRequestExternalActionEnvelope(
    pullRequestExternalActionPlan(
      { type: "comment", body: directInput.action.body },
      { binding: directInput.action.inputBinding },
    ),
  );
  const completedRecord = markerRecord(directInput, {
    kind: "review",
    id: 91,
    body: `${directInput.action.body}\n\n${directInput.marker}`,
    state: REVIEW_STATE.COMMENT,
    commitId: directInput.action.inputBinding.gitTarget.headRefOid,
  });
  const runner = new FakeRunner([
    actorRecord(directInput),
    pullRequestRecord(directInput),
    [],
    actorRecord(directInput),
    pullRequestRecord(directInput),
    [],
    actorRecord(directInput),
    pullRequestRecord(directInput),
    completedRecord,
    actorRecord(directInput),
    pullRequestRecord(directInput),
    [completedRecord],
  ]);
  const transport = actionTransport(runner);
  const executor = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialSource: credentialSource(),
    transport,
    inputAuthorityVerifier: {
      async verify() {
        return structuredClone(envelope.action.inputBinding);
      },
    },
  });

  assert.deepEqual(await executor.execute(envelope), {
    status: "applied",
    receipt: {
      id: "91",
      url: `https://github.com/${directInput.repository}/pull/${directInput.pullRequestNumber}`,
      createdAt: CREATED_AT,
    },
  });
  assert.equal(runner.responses.length, 0);
});

test("observes exact comment and review marker receipts without exposing URL fragments", async () => {
  for (const type of ["comment", "review"]) {
    const input = transportInput(type);
    const body = `${input.action.body}\n\n${input.marker}`;
    const reviewEvent = expectedReviewEvent(input);
    const record = markerRecord(input, {
      kind: "review",
      id: type === "review" ? 202 : 101,
      body,
      state: REVIEW_STATE[reviewEvent],
      commitId: input.action.inputBinding.gitTarget.headRefOid,
    });
    const runner = new FakeRunner([
      actorRecord(input),
      pullRequestRecord(input),
      [record],
    ]);

    const observation = await actionTransport(runner).observe(input);

    assert.equal(observation.actionEvidence.records.length, 1);
    const [evidence] = observation.actionEvidence.records;
    assert.equal(evidence.marker, input.marker);
    assert.equal(evidence.actorAccountId, input.actorAccountId);
    assert.equal(evidence.body, input.action.body);
    assert.equal(evidence.receipt.id, String(record.id));
    assert.equal(
      evidence.receipt.url,
      `https://github.com/${input.repository}/pull/${input.pullRequestNumber}`,
    );
    assert.equal(evidence.receipt.createdAt, CREATED_AT);
    assert.equal(evidence.reviewEvent, reviewEvent);
    assert.equal(
      evidence.headOid,
      input.action.inputBinding.gitTarget.headRefOid,
    );
  }
});

test("observes update-branch completion only from the exact two-parent head commit", async () => {
  const input = transportInput("update_branch");
  const nextHead = externalActionOid("7");
  const runner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input, { headOid: nextHead }),
    {
      sha: nextHead,
      html_url:
        `https://github.com/${input.action.inputBinding.gitTarget.headRepository}/commit/${nextHead}`,
      committer: { date: CREATED_AT },
      parents: [
        { sha: input.action.expectedHeadOid },
        { sha: input.action.expectedBaseOid },
      ],
    },
  ]);

  const observation = await actionTransport(runner).observe(input);

  assert.deepEqual(observation.actionEvidence, {
    kind: "head_commit",
    commit: {
      oid: nextHead,
      parents: [input.action.expectedHeadOid, input.action.expectedBaseOid],
      receipt: {
        id: nextHead,
        url:
          `https://github.com/${input.action.inputBinding.gitTarget.headRepository}/commit/${nextHead}`,
        createdAt: CREATED_AT,
      },
    },
  });
});

test("observes a merge only with matching actor, head, marker, method and receipt proof", async () => {
  const input = transportInput("merge");
  const mergeCommitOid = externalActionOid("8");
  const proof = markerRecord(input, {
    kind: "comment",
    id: 303,
    body: mergeProofBody(input, mergeCommitOid),
  });
  const runner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input, {
      state: "merged",
      mergeCommitOid,
    }),
    [proof],
  ]);

  const observation = await actionTransport(runner).observe(input);

  assert.equal(observation.state, "merged");
  assert.deepEqual(observation.actionEvidence, {
    kind: "merge_state",
    merge: {
      marker: input.marker,
      actorAccountId: input.actorAccountId,
      expectedHeadOid: input.action.expectedHeadOid,
      method: input.action.method,
      receipt: {
        id: mergeCommitOid,
        url: `https://github.com/${input.repository}/pull/${input.pullRequestNumber}`,
        createdAt: CREATED_AT,
      },
    },
  });
});

test("posts comments and all explicit reviews as exact Head-bound reviews with bodies on stdin", async () => {
  const binding = pullRequestExternalActionBinding();
  const inputs = [
    transportInput("comment", binding),
    ...[
      ["approve", "Approve this change."],
      ["request_changes", "Please revise this change."],
      ["comment", "This is an explicit review comment."],
    ].map(([verdict, body]) =>
      transportInput("review", binding, { type: "review", verdict, body })
    ),
  ];
  for (const input of inputs) {
    const body = `${input.action.body}\n\n${input.marker}`;
    const reviewEvent = expectedReviewEvent(input);
    const response = markerRecord(input, {
      kind: "review",
      id: input.actionType === "review" ? 502 : 501,
      body,
      state: REVIEW_STATE[reviewEvent],
      commitId: input.action.inputBinding.gitTarget.headRefOid,
    });
    const runner = new FakeRunner([
      actorRecord(input),
      pullRequestRecord(input),
      response,
    ]);

    assert.deepEqual(await actionTransport(runner).perform(input), {
      accepted: true,
    });

    const mutation = runner.calls.at(-1);
    assert.equal(mutation.args.includes("POST"), true);
    assert.equal(mutation.args.includes("--input"), true);
    assert.equal(mutation.args.includes(body), false);
    assert.equal(
      mutation.args.includes(
        `repos/${input.repository}/pulls/${input.pullRequestNumber}/reviews`,
      ),
      true,
    );
    assert.equal(
      mutation.args.includes(
        `repos/${input.repository}/issues/${input.pullRequestNumber}/comments`,
      ),
      false,
    );
    assert.deepEqual(JSON.parse(mutation.input), {
      event: reviewEvent,
      body,
      commit_id: input.action.inputBinding.gitTarget.headRefOid,
    });
    assert.equal(
      input.action.type,
      input.actionType === "comment"
        ? "pull_request_comment"
        : "pull_request_review",
    );
    assertSafeGhCalls(runner.calls);
  }
});

test("rejects self approval and change requests before mutation while allowing COMMENT", async () => {
  const binding = pullRequestExternalActionBinding();
  for (const verdict of ["approve", "request_changes"]) {
    const input = transportInput("review", binding, {
      type: "review",
      verdict,
      body: "Self review must not be submitted.",
    });
    const runner = new FakeRunner([
      actorRecord(input),
      pullRequestRecord(input, { authorAccountId: input.actorAccountId }),
    ]);

    await assert.rejects(
      actionTransport(runner).perform(input),
      assertTransportError("GITHUB_SELF_REVIEW_UNSUPPORTED", "absent"),
    );
    assert.equal(runner.calls.length, 2);
    assert.equal(
      runner.calls.some((call) => call.args.includes("POST") && !call.args.includes("graphql")),
      false,
    );
  }

  const commentInput = transportInput("review", binding, {
    type: "review",
    verdict: "comment",
    body: "A non-blocking self review comment is allowed.",
  });
  const body = `${commentInput.action.body}\n\n${commentInput.marker}`;
  const runner = new FakeRunner([
    actorRecord(commentInput),
    pullRequestRecord(commentInput, {
      authorAccountId: commentInput.actorAccountId,
    }),
    markerRecord(commentInput, {
      kind: "review",
      id: 503,
      body,
      state: REVIEW_STATE.COMMENT,
      commitId: commentInput.action.inputBinding.gitTarget.headRefOid,
    }),
  ]);

  assert.deepEqual(await actionTransport(runner).perform(commentInput), {
    accepted: true,
  });
});

test("binds a comment to confirmed H1 when Head changes after the final preflight", async () => {
  const input = transportInput("comment");
  const confirmedHead = input.action.inputBinding.gitTarget.headRefOid;
  const nextHead = externalActionOid("9");
  const body = `${input.action.body}\n\n${input.marker}`;
  let currentHead = confirmedHead;
  const runner = new FakeRunner([
    actorRecord(input),
    () => {
      const preflight = pullRequestRecord(input, { headOid: currentHead });
      currentHead = nextHead;
      return preflight;
    },
    (call) => {
      const usesReviewEndpoint = call.args.includes(
        `repos/${input.repository}/pulls/${input.pullRequestNumber}/reviews`,
      );
      return markerRecord(input, {
        kind: usesReviewEndpoint ? "review" : "comment",
        id: 503,
        body,
        state: usesReviewEndpoint ? REVIEW_STATE.COMMENT : undefined,
        commitId: usesReviewEndpoint ? confirmedHead : undefined,
      });
    },
  ]);

  assert.deepEqual(await actionTransport(runner).perform(input), {
    accepted: true,
  });

  assert.equal(currentHead, nextHead);
  const mutation = runner.calls.at(-1);
  assert.equal(
    mutation.args.includes(
      `repos/${input.repository}/pulls/${input.pullRequestNumber}/reviews`,
    ),
    true,
  );
  assert.equal(
    runner.calls.some((call) =>
      call.args.includes(
        `repos/${input.repository}/issues/${input.pullRequestNumber}/comments`,
      )
    ),
    false,
  );
  assert.deepEqual(JSON.parse(mutation.input), {
    event: "COMMENT",
    body,
    commit_id: confirmedHead,
  });
});

test("never accepts issue-comment, Head-less, wrong-event, or wrong-Head comment evidence", async () => {
  const input = transportInput("comment");
  const body = `${input.action.body}\n\n${input.marker}`;
  const records = [
    markerRecord(input, { kind: "comment", id: 801, body }),
    markerRecord(input, {
      kind: "review",
      id: 802,
      body,
      state: REVIEW_STATE.COMMENT,
    }),
    markerRecord(input, {
      kind: "review",
      id: 803,
      body,
      state: REVIEW_STATE.APPROVE,
      commitId: input.action.inputBinding.gitTarget.headRefOid,
    }),
    markerRecord(input, {
      kind: "review",
      id: 804,
      body,
      state: REVIEW_STATE.COMMENT,
      commitId: externalActionOid("9"),
    }),
  ];

  for (const record of records) {
    const runner = new FakeRunner([
      actorRecord(input),
      pullRequestRecord(input),
      [record],
    ]);

    await assert.rejects(
      actionTransport(runner).observe(input),
      assertTransportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown"),
    );
    assert.equal(
      runner.calls.at(-1).args.some((argument) =>
        argument.startsWith(
          `repos/${input.repository}/pulls/${input.pullRequestNumber}/reviews?`,
        )
      ),
      true,
    );
  }
});

test("updates a branch with expected_head_sha and waits for an exact merge commit", async () => {
  const input = transportInput("update_branch");
  const nextHead = externalActionOid("7");
  const runner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input),
    {
      message: "Updating pull request branch.",
      url: `https://api.github.com/repos/${input.repository}/pulls/${input.pullRequestNumber}`,
    },
    pullRequestRecord(input, { headOid: nextHead }),
    {
      sha: nextHead,
      html_url:
        `https://github.com/${input.action.inputBinding.gitTarget.headRepository}/commit/${nextHead}`,
      committer: { date: CREATED_AT },
      parents: [
        { sha: input.action.expectedHeadOid },
        { sha: input.action.expectedBaseOid },
      ],
    },
  ]);

  assert.deepEqual(await actionTransport(runner).perform(input), {
    accepted: true,
  });

  const mutation = runner.calls[2];
  assert.equal(mutation.args.includes("PUT"), true);
  assert.match(mutation.args.join(" "), /update-branch/u);
  assert.deepEqual(JSON.parse(mutation.input), {
    expected_head_sha: input.action.expectedHeadOid,
  });
});

for (const reviewRepair of [false, true]) {
test(`delegates ${reviewRepair ? "single-parent review repair" : "conflict merge"} push once to the exact frozen controlled publisher port`, async () => {
  const binding = pullRequestExternalActionBinding();
  const input = transportInput("push", binding, {
    type: "push",
    controlledCommitEvidence: externalActionControlledCommit(binding, { reviewRepair }),
  });
  const published = [];
  const publisher = Object.freeze({
    async publish(request) {
      published.push(structuredClone(request));
      return Object.freeze({
        status: "applied",
        receipt: Object.freeze({
          id: input.action.controlledCommitEvidence.commit.oid,
        }),
      });
    },
  });
  const runner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input),
  ]);

  assert.deepEqual(
    await actionTransport(runner, {
      controlledCommitPublisher: publisher,
    }).perform(input),
    { accepted: true },
  );

  assert.equal(published.length, 1);
  assert.deepEqual(Reflect.ownKeys(published[0]), [
    "credential",
    "actorAccountId",
    "repository",
    "pullRequestNumber",
    "marker",
    "action",
  ]);
  assert.deepEqual(published[0], {
    credential: CREDENTIAL,
    actorAccountId: input.actorAccountId,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
    marker: input.marker,
    action: input.action,
  });
  assert.equal(
    runner.calls.some((call) =>
      call.args.some((argument) => /push|git\/refs|git-receive/u.test(argument))
    ),
    false,
  );
});
}

test("single-parent review repair crosses the real executor and transport without duplicate publication", async () => {
  const binding = pullRequestExternalActionBinding();
  const evidence = externalActionControlledCommit(binding, { reviewRepair: true });
  const plan = pullRequestExternalActionPlan({ type: "push", controlledCommitEvidence: evidence }, { binding });
  const envelope = pullRequestExternalActionEnvelope(plan);
  const input = transportInput("push", binding, { type: "push", controlledCommitEvidence: evidence });
  const before = () => [actorRecord(input), pullRequestRecord(input)];
  const after = () => [actorRecord(input), pullRequestRecord(input, { headOid: evidence.commit.oid })];
  const runner = new FakeRunner([...before(), ...before(), ...before(), ...after(), ...after()]);
  let publications = 0;
  const executor = createPullRequestExternalActionExecutor({
    enabledActions: ["push"],
    credentialSource: credentialSource(),
    transport: actionTransport(runner, {
      controlledCommitPublisher: Object.freeze({
        async publish(request) {
          publications += 1;
          assert.deepEqual(request.action.controlledCommitEvidence, evidence);
          return { status: "applied", receipt: { id: evidence.commit.oid } };
        },
      }),
    }),
    inputAuthorityVerifier: { async verify() { return structuredClone(binding); } },
    controlledCommitVerifier: { async verify() { return structuredClone(evidence); } },
    pushAuthorization: { async verifyPush() { return true; } },
  });
  assert.deepEqual(await executor.execute(envelope), { status: "applied", receipt: { id: evidence.commit.oid } });
  assert.deepEqual(await executor.reconcile(envelope), { status: "already", receipt: { id: evidence.commit.oid } });
  assert.equal(publications, 1);
  assert.equal(runner.responses.length, 0);
});

test("merges with an expected sha before writing a recoverable proof comment", async () => {
  const input = transportInput("merge");
  const mergeCommitOid = externalActionOid("8");
  const proofBody = mergeProofBody(input, mergeCommitOid);
  const proofRecord = markerRecord(input, {
    kind: "comment",
    id: 601,
    body: proofBody,
  });
  const runner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input),
    { merged: true, sha: mergeCommitOid, message: "Pull Request successfully merged" },
    proofRecord,
  ]);

  assert.deepEqual(await actionTransport(runner).perform(input), {
    accepted: true,
  });

  assert.deepEqual(JSON.parse(runner.calls[2].input), {
    sha: input.action.expectedHeadOid,
    merge_method: input.action.method,
  });
  assert.deepEqual(JSON.parse(runner.calls[3].input), { body: proofBody });
  assert.match(runner.calls[2].args.join(" "), /pulls\/42\/merge/u);
  assert.match(runner.calls[3].args.join(" "), /issues\/42\/comments/u);
});

test("rejects active, extra and mismatched inputs before any port is called", async () => {
  const input = transportInput("comment");
  for (const corrupt of [
    { ...structuredClone(input), extra: true },
    { ...structuredClone(input), repository: "acme/repo/extra" },
    { ...structuredClone(input), actionType: "review" },
  ]) {
    const runner = new FakeRunner([]);
    await assert.rejects(
      actionTransport(runner).observe(corrupt),
      assertTransportError("GITHUB_PROTOCOL_ERROR", "absent"),
    );
    assert.equal(runner.calls.length, 0);
  }

  let getterCalls = 0;
  const active = structuredClone(input);
  Object.defineProperty(active, "action", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return input.action;
    },
  });
  const runner = new FakeRunner([]);
  await assert.rejects(
    actionTransport(runner).observe(active),
    assertTransportError("GITHUB_PROTOCOL_ERROR", "absent"),
  );
  assert.equal(getterCalls, 0);
  assert.equal(runner.calls.length, 0);
});

test("pins constructor paths and rejects active or unsupported network settings", () => {
  assert.throws(
    () => createGitHubPullRequestActionTransport({ ghCommand: "gh" }),
    /fixed absolute/u,
  );
  assert.throws(
    () => createGitHubPullRequestActionTransport({
      ghCommand: GH_COMMAND,
      networkEnv: { GH_HOST: "evil.example" },
    }),
    /unsupported/u,
  );
  const networkEnv = {};
  Object.defineProperty(networkEnv, "NO_PROXY", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  assert.throws(
    () => createGitHubPullRequestActionTransport({
      ghCommand: GH_COMMAND,
      networkEnv,
    }),
    PullRequestExternalActionTransportError,
  );

  let environmentGetterCalls = 0;
  const activeEnvironment = {};
  Object.defineProperty(activeEnvironment, "SystemRoot", {
    enumerable: true,
    get() {
      environmentGetterCalls += 1;
      return "C:\\Windows";
    },
  });
  assert.throws(
    () => createGitHubPullRequestActionTransport({
      ghCommand: GH_COMMAND,
      env: activeEnvironment,
    }),
    /active or invalid/u,
  );
  assert.equal(environmentGetterCalls, 0);

  let environmentProxyTraps = 0;
  const proxiedEnvironment = new Proxy({}, {
    getOwnPropertyDescriptor() {
      environmentProxyTraps += 1;
      throw new Error("must not inspect proxy");
    },
    get() {
      environmentProxyTraps += 1;
      throw new Error("must not inspect proxy");
    },
  });
  assert.throws(
    () => createGitHubPullRequestActionTransport({
      ghCommand: GH_COMMAND,
      env: proxiedEnvironment,
    }),
    /passive environment/u,
  );
  assert.equal(environmentProxyTraps, 0);
});

test("classifies read failures absent and failures after a mutation starts unknown", async () => {
  const input = transportInput("comment");
  const timeout = () =>
    new ManagedProcessError("PROCESS_TIMEOUT", "timed out", {
      details: { stdout: "", stderr: "", exitCode: null },
    });
  await assert.rejects(
    actionTransport(new FakeRunner([timeout()])).observe(input),
    assertTransportError("GITHUB_TIMEOUT", "absent"),
  );

  const postRunner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input),
    timeout(),
  ]);
  await assert.rejects(
    actionTransport(postRunner).perform(input),
    assertTransportError("GITHUB_TIMEOUT", "unknown"),
  );
});

test("actor and Head mismatches stop before every external mutation", async () => {
  const input = transportInput("comment");
  const wrongActorRunner = new FakeRunner([{ login: "someone-else" }]);
  await assert.rejects(
    actionTransport(wrongActorRunner).perform(input),
    assertTransportError("GITHUB_ACTOR_MISMATCH", "absent"),
  );
  assert.equal(wrongActorRunner.calls.length, 1);

  const staleRunner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input, { headOid: externalActionOid("9") }),
  ]);
  await assert.rejects(
    actionTransport(staleRunner).perform(input),
    assertTransportError("GITHUB_TARGET_STALE", "absent"),
  );
  assert.equal(staleRunner.calls.length, 2);
});

test("a historical base SHA cannot permit a mutation after its live base moved", async () => {
  const input = transportInput("comment");
  const pr = pullRequestRecord(input);
  pr.base.liveSha = externalActionOid("9");
  const runner = new FakeRunner([actorRecord(input), pr]);
  await assert.rejects(actionTransport(runner).perform(input), assertTransportError("GITHUB_TARGET_STALE", "absent"));
  assert.equal(runner.calls.some((call) => call.args.includes("POST") && !call.args.includes("graphql")), false);
});

test("terminal receipt reconciliation survives a deleted head without permitting another mutation", async () => {
  const input = transportInput("merge");
  const mergeCommitOid = externalActionOid("8");
  const pr = { ...pullRequestRecord(input, { state: "merged", mergeCommitOid }), headRefDeleted: true };
  const proof = markerRecord(input, { kind: "comment", id: 303, body: mergeProofBody(input, mergeCommitOid) });
  const observation = await actionTransport(new FakeRunner([actorRecord(input), pr, [proof]])).observe(input);
  assert.equal(observation.state, "merged");
  assert.equal(observation.actionEvidence.merge.receipt.id, mergeCommitOid);
  const runner = new FakeRunner([actorRecord(input), pr]);
  await assert.rejects(actionTransport(runner).perform(input), assertTransportError("GITHUB_TARGET_STALE", "absent"));
  assert.equal(runner.calls.some((call) => call.args.includes("POST") && !call.args.includes("graphql")), false);
});

test("fails closed at the fixed pagination bound", async () => {
  const input = transportInput("comment");
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    body: "unrelated",
  }));
  const runner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input),
    ...Array.from({ length: 10 }, () => fullPage),
  ]);

  await assert.rejects(
    actionTransport(runner).observe(input),
    assertTransportError("GITHUB_PAGINATION_LIMIT", "absent"),
  );
  assert.equal(runner.calls.length, 12);
  assert.match(runner.calls.at(-1).args.join(" "), /page=10/u);
});

test("maps controlled publisher stale and unknown results without guessing", async () => {
  const input = transportInput("push");
  for (const [result, code, trust] of [
    [{ status: "stale" }, "GITHUB_PUSH_STALE", "absent"],
    [
      {
        status: "unknown",
        code: "CONTROLLED_GIT_PUBLISH_OUTCOME_UNKNOWN",
      },
      "CONTROLLED_GIT_PUBLISH_OUTCOME_UNKNOWN",
      "unknown",
    ],
    [
      { status: "applied", receipt: { id: externalActionOid("9") } },
      "CONTROLLED_GIT_PUBLISH_PROTOCOL_ERROR",
      "unknown",
    ],
  ]) {
    const runner = new FakeRunner([
      actorRecord(input),
      pullRequestRecord(input),
    ]);
    await assert.rejects(
      actionTransport(runner, {
        controlledCommitPublisher: {
          async publish() { return result; },
        },
      }).perform(input),
      assertTransportError(code, trust),
    );
  }
});

test("treats malformed or conflicting marker evidence as unknown, never absent", async () => {
  const input = transportInput("comment");
  const runner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input),
    [markerRecord(input, {
      kind: "review",
      id: 700,
      body: `different body\n\n${input.marker}`,
      state: REVIEW_STATE.COMMENT,
      commitId: input.action.inputBinding.gitTarget.headRefOid,
    })],
  ]);

  await assert.rejects(
    actionTransport(runner).observe(input),
    assertTransportError("GITHUB_COMPLETION_PROOF_CONFLICT", "unknown"),
  );
});

test("a merge with a lost proof comment stays unknown after restart", async () => {
  const binding = pullRequestExternalActionBinding();
  const input = transportInput("merge", binding);
  const envelope = pullRequestExternalActionEnvelope(
    pullRequestExternalActionPlan(proposalAction("merge", binding), { binding }),
  );
  const mergeCommitOid = externalActionOid("8");
  const timeout = new ManagedProcessError("PROCESS_TIMEOUT", "timed out", {
    details: { stdout: "", stderr: "", exitCode: null },
  });
  const firstRunner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input),
    { merged: true, sha: mergeCommitOid, message: "Pull Request successfully merged" },
    timeout,
  ]);
  await assert.rejects(
    actionTransport(firstRunner).perform(input),
    assertTransportError("GITHUB_TIMEOUT", "unknown"),
  );

  const recoveryRunner = new FakeRunner([
    actorRecord(input),
    pullRequestRecord(input, { state: "merged", mergeCommitOid }),
    [],
  ]);
  const recoveryTransport = actionTransport(recoveryRunner);
  const executor = createPullRequestExternalActionExecutor({
    enabledActions: ["merge"],
    credentialSource: credentialSource(),
    transport: recoveryTransport,
    inputAuthorityVerifier: {
      async verify() {
        return structuredClone(binding);
      },
    },
  });

  assert.deepEqual(await executor.reconcile(envelope), {
    status: "error",
    error: {
      code: "GITHUB_COMPLETION_PROOF_CONFLICT",
      trust: "unknown",
    },
  });
  assert.equal(recoveryRunner.calls.length, 3);
  assert.equal(
    recoveryRunner.calls.some((call) => call.args.includes("POST") && !call.args.includes("graphql")),
    false,
  );
});
