import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { pullRequestExternalActionMarker } from "../src/domain/pull-request-external-action.js";
import {
  PullRequestExternalActionTransportError,
  createPullRequestExternalActionExecutor,
} from "../src/services/pull-request-external-action-executor.js";
import {
  githubCredentialSourceError,
} from "../src/lib/github-credential-source.js";
import {
  externalActionControlledCommit,
  externalActionOid,
  pullRequestExternalActionBinding,
  pullRequestExternalActionEnvelope,
  pullRequestExternalActionPlan,
} from "./support/pull-request-external-action-fixture.js";

const RECEIPT_AT = "2026-08-08T06:08:09.012Z";
const ACTION_TYPES = ["comment", "review", "update_branch", "push", "merge"];

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

function proposalAction(type, binding) {
  return {
    comment: { type, body: "Post this comment." },
    review: { type, verdict: "approve", body: "Review passed." },
    update_branch: { type },
    push: {
      type,
      controlledCommitEvidence: externalActionControlledCommit(binding),
    },
    merge: { type, method: "squash" },
  }[type];
}

function envelopeFor(type, binding = pullRequestExternalActionBinding()) {
  return pullRequestExternalActionEnvelope(
    pullRequestExternalActionPlan(proposalAction(type, binding), { binding }),
  );
}

function receipt(id, suffix) {
  return {
    id,
    url: `https://github.com/acme/repo/${suffix}`,
    createdAt: RECEIPT_AT,
  };
}

function observationFor(envelope, overrides = {}) {
  const actionType = envelope.action.type;
  const actionEvidence = {
    pull_request_comment: { kind: "marker_records", records: [] },
    pull_request_review: { kind: "marker_records", records: [] },
    pull_request_update_branch: { kind: "head_commit", commit: null },
    pull_request_push: { kind: "head_ref" },
    pull_request_merge: { kind: "merge_state", merge: null },
  }[actionType];
  return {
    schemaVersion: 1,
    actorAccountId: envelope.actor.accountId,
    gitTarget: structuredClone(envelope.action.inputBinding.gitTarget),
    state: "open",
    actionEvidence,
    ...structuredClone(overrides),
  };
}

function completedObservation(envelope, marker) {
  const current = observationFor(envelope);
  if (envelope.action.type === "pull_request_comment") {
    current.actionEvidence.records = [{
      marker,
      actorAccountId: envelope.actor.accountId,
      body: envelope.action.body,
      reviewEvent: "COMMENT",
      headOid: envelope.action.inputBinding.gitTarget.headRefOid,
      receipt: receipt("101", "pull/42"),
    }];
    return current;
  }
  if (envelope.action.type === "pull_request_review") {
    current.actionEvidence.records = [{
      marker,
      actorAccountId: envelope.actor.accountId,
      body: envelope.action.body,
      reviewEvent: envelope.action.reviewEvent,
      headOid: envelope.action.inputBinding.gitTarget.headRefOid,
      receipt: receipt("202", "pull/42"),
    }];
    return current;
  }
  if (envelope.action.type === "pull_request_update_branch") {
    const nextHead = externalActionOid("7");
    current.gitTarget.headRefOid = nextHead;
    current.actionEvidence.commit = {
      oid: nextHead,
      parents: [envelope.action.expectedHeadOid, envelope.action.expectedBaseOid],
      receipt: receipt(nextHead, "pull/42"),
    };
    return current;
  }
  if (envelope.action.type === "pull_request_push") {
    current.gitTarget.headRefOid = envelope.action.controlledCommitEvidence.commit.oid;
    return current;
  }
  current.state = "merged";
  current.gitTarget.baseRefOid = externalActionOid("8");
  current.actionEvidence.merge = {
    marker,
    actorAccountId: envelope.actor.accountId,
    expectedHeadOid: envelope.action.expectedHeadOid,
    method: envelope.action.method,
    receipt: receipt(externalActionOid("8"), "pull/42"),
  };
  return current;
}

function mutableTransport(
  envelope,
  { loseResponse = false, headAfterMutation = null } = {},
) {
  let observation = observationFor(envelope);
  const calls = [];
  return {
    calls,
    setObservation(value) {
      observation = structuredClone(value);
    },
    async observe(input) {
      calls.push({ method: "observe", input: structuredClone(input) });
      return structuredClone(observation);
    },
    async perform(input) {
      calls.push({ method: "perform", input: structuredClone(input) });
      observation = completedObservation(envelope, input.marker);
      if (headAfterMutation !== null) {
        observation.gitTarget.headRefOid = headAfterMutation;
      }
      if (loseResponse) {
        throw new PullRequestExternalActionTransportError(
          "GITHUB_RESPONSE_LOST",
          "unknown",
        );
      }
      return { accepted: true };
    },
  };
}

function acceptingAuthority(binding) {
  return { async verify() { return structuredClone(binding); } };
}

function acceptingCommit(evidence) {
  return {
    async verify({ evidenceId }) {
      assert.equal(evidenceId, evidence.evidenceId);
      return structuredClone(evidence);
    },
  };
}

function recordingCredentialSource(token = "fictional_generic_token") {
  const calls = { acquire: [], use: 0, release: 0 };
  return {
    calls,
    token,
    source: Object.freeze({
      async acquire(request) {
        calls.acquire.push(request);
        return Object.freeze({
          async use(callback) {
            calls.use += 1;
            return callback(token);
          },
          release() { calls.release += 1; },
        });
      },
    }),
  };
}

function executorFor(envelope, transport, overrides = {}) {
  return createPullRequestExternalActionExecutor({
    enabledActions: ACTION_TYPES,
    credentialSource: recordingCredentialSource("runtime-secret").source,
    transport,
    inputAuthorityVerifier: acceptingAuthority(envelope.action.inputBinding),
    ...(envelope.action.controlledCommitEvidence
      ? {
          controlledCommitVerifier: acceptingCommit(
            envelope.action.controlledCommitEvidence,
          ),
        }
      : {}),
    ...overrides,
  });
}

test("external actions are disabled by default and missing credentials never reach transport", async () => {
  const envelope = envelopeFor("comment");
  let credentials = 0;
  const transport = {
    observe() { throw new Error("must not observe"); },
    perform() { throw new Error("must not perform"); },
  };
  const disabled = createPullRequestExternalActionExecutor({
    transport,
  });

  assert.deepEqual(await disabled.execute(envelope), { status: "stale" });
  assert.deepEqual(await disabled.reconcile(envelope), { status: "stale" });
  assert.equal(credentials, 0);

  const enabled = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialSource: Object.freeze({
      async acquire() {
        credentials += 1;
        throw githubCredentialSourceError("GITHUB_CREDENTIAL_MISSING");
      },
    }),
    transport,
    inputAuthorityVerifier: acceptingAuthority(envelope.action.inputBinding),
  });
  assert.deepEqual(await enabled.execute(envelope), {
    status: "error",
    error: { code: "GITHUB_CREDENTIAL_MISSING", trust: "absent" },
  });
  assert.equal(credentials, 1);

  assert.throws(() => createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialProvider: () => "legacy-secret",
    transport,
    inputAuthorityVerifier: acceptingAuthority(envelope.action.inputBinding),
  }), /credentialSource/u);
});

test("one generic execution acquires, uses, and releases one actor-bound lease", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  const credential = recordingCredentialSource();
  const executor = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialSource: credential.source,
    transport,
    inputAuthorityVerifier: acceptingAuthority(envelope.action.inputBinding),
    clock: () => 1_000_000,
    timeoutMs: 60_000,
  });

  const result = await executor.execute(envelope);

  assert.equal(result.status, "applied");
  assert.equal(credential.calls.acquire.length, 1);
  assert.equal(credential.calls.acquire[0].actorAccountId, envelope.actor.accountId);
  assert.equal(credential.calls.acquire[0].deadline, 1_060_000);
  assert.equal(credential.calls.acquire[0].signal instanceof AbortSignal, true);
  assert.equal(credential.calls.use, 1);
  assert.equal(credential.calls.release, 1);
  assert.equal(JSON.stringify(result).includes(credential.token), false);
});

test("controlled push shares its aggregate budget across repeated local verification", async () => {
  const envelope = envelopeFor("push");
  const transport = mutableTransport(envelope);
  let now = 1_000_000;
  const executor = executorFor(envelope, transport, {
    clock: () => now, timeoutMs: 60_000,
    controlledCommitVerifier: { async verify() {
      now += 68_000;
      return structuredClone(envelope.action.controlledCommitEvidence);
    } },
    pushAuthorization: { async verifyPush() { now += 68_000; return true; } },
  });
  assert.equal((await executor.execute(envelope)).status, "applied");
  assert.ok(now > 1_060_000, "the bounded stages exceed a single request budget in aggregate");
  assert.equal(transport.calls.filter(x => x.method === "perform").length, 1);
});

test("one slow controlled verification remains bounded within the aggregate push budget", async () => {
  const envelope = envelopeFor("push");
  const transport = mutableTransport(envelope);
  const credential = recordingCredentialSource();
  let now = 1_000_000;
  const executor = executorFor(envelope, transport, {
    credentialSource: credential.source, clock: () => now, timeoutMs: 60_000,
    controlledCommitVerifier: { async verify() {
      now += 600_001;
      return structuredClone(envelope.action.controlledCommitEvidence);
    } },
  });
  assert.deepEqual(await executor.execute(envelope), { status: "error", error: { code: "GITHUB_TIMEOUT", trust: "absent" } });
  assert.equal(credential.calls.acquire.length, 0);
  assert.deepEqual(transport.calls, []);
});

test("one generic reconcile acquires, uses, and releases one actor-bound lease", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  const credential = recordingCredentialSource();
  const executor = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialSource: credential.source,
    transport,
    inputAuthorityVerifier: acceptingAuthority(envelope.action.inputBinding),
  });

  assert.equal((await executor.reconcile(envelope)).status, "absent");
  assert.equal(credential.calls.acquire.length, 1);
  assert.equal(credential.calls.use, 1);
  assert.equal(credential.calls.release, 1);
});

test("closing the generic executor releases its lease and prevents later stages", async () => {
  const envelope = envelopeFor("comment");
  const credential = recordingCredentialSource();
  let executor;
  const calls = [];
  const transport = {
    async observe() {
      calls.push("observe");
      executor.close();
      return observationFor(envelope);
    },
    async perform() { calls.push("perform"); },
  };
  executor = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialSource: credential.source,
    transport,
    inputAuthorityVerifier: acceptingAuthority(envelope.action.inputBinding),
  });

  const result = await executor.execute(envelope);

  assert.deepEqual(result, {
    status: "error",
    error: { code: "GITHUB_UNAVAILABLE", trust: "absent" },
  });
  assert.deepEqual(calls, ["observe"]);
  assert.equal(credential.calls.release, 1);
  assert.equal(credential.calls.acquire[0].signal.aborted, true);
});

test("closing generic execution bounds a hanging authority verifier", async () => {
  const envelope = envelopeFor("comment");
  const started = deferred();
  const pending = deferred();
  const credential = recordingCredentialSource();
  const transport = mutableTransport(envelope);
  const executor = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialSource: credential.source,
    transport,
    inputAuthorityVerifier: {
      async verify() {
        started.resolve();
        return pending.promise;
      },
    },
  });

  const execution = executor.execute(envelope);
  await started.promise;
  executor.close();

  assert.deepEqual(await settleWithin(execution), {
    status: "error",
    error: { code: "GITHUB_UNAVAILABLE", trust: "absent" },
  });
  assert.equal(credential.calls.acquire.length, 0);
  assert.deepEqual(transport.calls, []);
  await assertLateRejectionHandled(pending);
});

test("generic deadline bounds a hanging authority recheck and releases its lease", async (t) => {
  const envelope = envelopeFor("comment");
  let now = 5_000_000;
  let operationTimer;
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    operationTimer = { callback, milliseconds, unref() {} };
    return operationTimer;
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const started = deferred();
  const pending = deferred();
  let checks = 0;
  const credential = recordingCredentialSource();
  const transport = mutableTransport(envelope);
  const executor = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialSource: credential.source,
    transport,
    inputAuthorityVerifier: {
      async verify() {
        checks += 1;
        if (checks === 1) return structuredClone(envelope.action.inputBinding);
        started.resolve();
        return pending.promise;
      },
    },
    clock: () => now,
    timeoutMs: 1_000,
  });

  const execution = executor.execute(envelope);
  await started.promise;
  now = 5_001_000;
  operationTimer.callback();

  assert.deepEqual(await settleWithin(execution), {
    status: "error",
    error: { code: "GITHUB_TIMEOUT", trust: "absent" },
  });
  assert.deepEqual(transport.calls.map(({ method }) => method), ["observe"]);
  assert.equal(credential.calls.release, 1);
  await assertLateRejectionHandled(pending);
});

test("closing generic execution bounds a hanging controlled-commit verifier", async () => {
  const envelope = envelopeFor("push");
  const started = deferred();
  const pending = deferred();
  const credential = recordingCredentialSource();
  const transport = mutableTransport(envelope);
  const executor = createPullRequestExternalActionExecutor({
    enabledActions: ["push"],
    credentialSource: credential.source,
    transport,
    inputAuthorityVerifier: acceptingAuthority(envelope.action.inputBinding),
    controlledCommitVerifier: {
      async verify() {
        started.resolve();
        return pending.promise;
      },
    },
  });

  const execution = executor.execute(envelope);
  await started.promise;
  executor.close();

  assert.deepEqual(await settleWithin(execution), {
    status: "error",
    error: { code: "GITHUB_UNAVAILABLE", trust: "absent" },
  });
  assert.equal(credential.calls.acquire.length, 0);
  assert.deepEqual(transport.calls, []);
  await assertLateRejectionHandled(pending);
});

test("all five actions execute once and reconcile from action-specific proof", async () => {
  for (const type of ACTION_TYPES) {
    const envelope = envelopeFor(type);
    const transport = mutableTransport(envelope);
    const executor = executorFor(envelope, transport);

    const applied = await executor.execute(envelope);
    const repeated = await executor.execute(envelope);
    const already = await executor.reconcile(envelope);

    assert.equal(applied.status, "applied", type);
    assert.equal(repeated.status, "already", type);
    assert.equal(already.status, "already", type);
    assert.deepEqual(already.receipt, applied.receipt, type);
    assert.equal(
      transport.calls.filter(({ method }) => method === "perform").length,
      1,
      type,
    );
    const performed = transport.calls.find(({ method }) => method === "perform");
    assert.equal(performed.input.credential, "runtime-secret");
    assert.equal(performed.input.repository, "acme/repo");
    assert.equal(performed.input.pullRequestNumber, 42);
    assert.equal(JSON.stringify(applied).includes("runtime-secret"), false);
  }
});

function ownPrRepairEnvelope() {
  const binding = pullRequestExternalActionBinding();
  return pullRequestExternalActionEnvelope(pullRequestExternalActionPlan({
    type: "push",
    controlledCommitEvidence: externalActionControlledCommit(binding, { reviewRepair: true }),
  }, { binding }));
}

test("automatic repair push requires its authorization before acquiring credentials", async () => {
  const envelope = ownPrRepairEnvelope();
  const credential = recordingCredentialSource();
  const transport = mutableTransport(envelope);
  const executor = executorFor(envelope, transport, {
    enabledActions: ["push"],
    credentialSource: credential.source,
    pushAuthorization: { async verifyPush(actual) { assert.deepEqual(actual, envelope); return false; } },
  });
  assert.deepEqual(await executor.execute(envelope), { status: "stale" });
  assert.equal(credential.calls.acquire.length, 0);
  assert.deepEqual(transport.calls, []);
});

test("automatic repair push rechecks authorization immediately before publishing", async () => {
  for (const revoke of [false, true]) {
    const envelope = ownPrRepairEnvelope();
    const transport = mutableTransport(envelope);
    let checks = 0;
    const executor = executorFor(envelope, transport, {
      enabledActions: ["push"],
      pushAuthorization: { async verifyPush() { checks += 1; return !revoke || checks < 3; } },
    });
    const result = await executor.execute(envelope);
    assert.equal(checks, 3);
    assert.equal(result.status, revoke ? "stale" : "applied");
    assert.equal(transport.calls.filter(({ method }) => method === "perform").length, revoke ? 0 : 1);
  }
});

test("unavailable automatic repair authorization preserves an unknown recovery outcome", async () => {
  const envelope = ownPrRepairEnvelope();
  const transport = mutableTransport(envelope);
  const executor = executorFor(envelope, transport, {
    enabledActions: ["push"],
    pushAuthorization: { async verifyPush() {
      throw Object.assign(new Error("authorization is recovering"), { code: "GITHUB_AUTHORIZATION_UNAVAILABLE" });
    } },
  });
  const result = await executor.reconcile(envelope);
  assert.equal(result.status, "error");
  assert.equal(result.error.trust, "unknown");
  assert.equal(transport.calls.filter(({ method }) => method === "perform").length, 0);
});

test("revoked automatic repair authorization cannot clear an unknown push recovery fence", async () => {
  const envelope = ownPrRepairEnvelope();
  const transport = mutableTransport(envelope);
  const executor = executorFor(envelope, transport, {
    enabledActions: ["push"],
    pushAuthorization: { async verifyPush() { return false; } },
  });
  const result = await executor.reconcile(envelope);
  assert.equal(result.status, "error");
  assert.equal(result.error.trust, "unknown");
  assert.equal(transport.calls.filter(({ method }) => method === "perform").length, 0);
});

test("disabling own PR repair across restart preserves an admitted unknown push", async () => {
  const envelope = ownPrRepairEnvelope();
  const transport = mutableTransport(envelope);
  const disabled = executorFor(envelope, transport, { enabledActions: [] });
  assert.deepEqual(await disabled.execute(envelope), { status: "stale" });
  const result = await disabled.reconcile(envelope);
  assert.equal(result.status, "error");
  assert.equal(result.error.trust, "unknown");
  assert.deepEqual(transport.calls, []);
});

test("ordinary push permission cannot clear a repair recovery fence after its switch is disabled", async () => {
  const envelope = ownPrRepairEnvelope();
  const transport = mutableTransport(envelope);
  const executor = executorFor(envelope, transport, {
    enabledActions: ["push"],
    inputAuthorityVerifier: { async verify() { throw new Error("revoked source"); } },
  });
  const result = await executor.reconcile(envelope);
  assert.equal(result.status, "error");
  assert.equal(result.error.trust, "unknown");
  assert.equal(transport.calls.filter(({ method }) => method === "perform").length, 0);
});

test("a lost mutation response is unknown until reconciliation proves already", async () => {
  for (const type of ACTION_TYPES) {
    const envelope = envelopeFor(type);
    const transport = mutableTransport(envelope, { loseResponse: true });
    const executor = executorFor(envelope, transport);

    assert.deepEqual(await executor.execute(envelope), {
      status: "error",
      error: { code: "GITHUB_RESPONSE_LOST", trust: "unknown" },
    }, type);
    assert.equal((await executor.reconcile(envelope)).status, "already", type);
    assert.equal(
      transport.calls.filter(({ method }) => method === "perform").length,
      1,
      type,
    );
  }
});

test("a lost H1 comment acknowledgement reconciles at H2 without replay", async () => {
  const envelope = envelopeFor("comment");
  const confirmedHead = envelope.action.inputBinding.gitTarget.headRefOid;
  const nextHead = externalActionOid("9");
  const transport = mutableTransport(envelope, {
    loseResponse: true,
    headAfterMutation: nextHead,
  });
  let revoked = false;
  let authorityChecks = 0;
  const executor = executorFor(envelope, transport, {
    inputAuthorityVerifier: {
      async verify() {
        authorityChecks += 1;
        if (revoked) throw new Error("H1 authority was revoked at H2");
        return structuredClone(envelope.action.inputBinding);
      },
    },
  });

  assert.deepEqual(await executor.execute(envelope), {
    status: "error",
    error: { code: "GITHUB_RESPONSE_LOST", trust: "unknown" },
  });
  revoked = true;
  const checksBeforeRecovery = authorityChecks;

  assert.equal((await executor.reconcile(envelope)).status, "already");
  assert.equal((await executor.reconcile(envelope)).status, "already");
  assert.equal(authorityChecks, checksBeforeRecovery);
  const mutations = transport.calls.filter(({ method }) => method === "perform");
  assert.equal(mutations.length, 1);
  assert.equal(
    mutations[0].input.action.inputBinding.gitTarget.headRefOid,
    confirmedHead,
  );
});

test("issue-comment-shaped or Head-less marker evidence cannot complete a comment", async () => {
  const envelope = envelopeFor("comment");
  const marker = pullRequestExternalActionMarker(envelope);
  const transport = mutableTransport(envelope);
  const headless = completedObservation(envelope, marker);
  delete headless.actionEvidence.records[0].reviewEvent;
  delete headless.actionEvidence.records[0].headOid;
  headless.actionEvidence.records[0].receipt.id = "issue-comment-101";
  transport.setObservation(headless);

  assert.deepEqual(await executorFor(envelope, transport).reconcile(envelope), {
    status: "error",
    error: { code: "GITHUB_PROTOCOL_ERROR", trust: "unknown" },
  });
  assert.equal(transport.calls.some(({ method }) => method === "perform"), false);
});

test("H1 review evidence cannot establish H2 comment authority", async () => {
  const h1 = externalActionOid("2");
  const h2 = externalActionOid("9");
  const binding = pullRequestExternalActionBinding({
    headRefOid: h2,
    gitTarget: { headRefOid: h2 },
  });
  const envelope = envelopeFor("comment", binding);
  const marker = pullRequestExternalActionMarker(envelope);
  const transport = mutableTransport(envelope);
  const mismatched = completedObservation(envelope, marker);
  mismatched.actionEvidence.records[0].headOid = h1;
  transport.setObservation(mismatched);

  assert.deepEqual(await executorFor(envelope, transport).reconcile(envelope), {
    status: "error",
    error: {
      code: "GITHUB_COMPLETION_PROOF_CONFLICT",
      trust: "unknown",
    },
  });
  assert.equal(transport.calls.some(({ method }) => method === "perform"), false);
});

test("stale target or authority never performs an external action", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  const stale = observationFor(envelope);
  stale.gitTarget.headRefOid = externalActionOid("9");
  transport.setObservation(stale);
  const executor = executorFor(envelope, transport);

  assert.deepEqual(await executor.execute(envelope), { status: "stale" });
  assert.equal(transport.calls.some(({ method }) => method === "perform"), false);

  const currentTransport = mutableTransport(envelope);
  let checks = 0;
  const revoked = executorFor(envelope, currentTransport, {
    inputAuthorityVerifier: {
      async verify() {
        checks += 1;
        if (checks === 1) return structuredClone(envelope.action.inputBinding);
        throw new Error("revoked");
      },
    },
  });
  assert.deepEqual(await revoked.execute(envelope), { status: "stale" });
  assert.equal(currentTransport.calls.some(({ method }) => method === "perform"), false);
});

test("stale input authority is fenced before credentials or transport", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  const credential = recordingCredentialSource("runtime-secret");
  const executor = executorFor(envelope, transport, {
    credentialSource: credential.source,
    inputAuthorityVerifier: {
      async verify() {
        throw new Error("the PR Head changed before owner confirmation");
      },
    },
  });

  assert.deepEqual(await executor.execute(envelope), { status: "stale" });
  assert.equal(credential.calls.acquire.length, 0);
  assert.deepEqual(transport.calls, []);
});

test("pre-credential stale and verification errors clear operation timers", async (t) => {
  const timers = [];
  const cleared = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timer = { callback, delay, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => cleared.push(timer));

  const staleEnvelope = envelopeFor("comment");
  const staleCredential = recordingCredentialSource();
  const staleTransport = mutableTransport(staleEnvelope);
  const staleExecutor = createPullRequestExternalActionExecutor({
    enabledActions: ["comment"],
    credentialSource: staleCredential.source,
    transport: staleTransport,
    inputAuthorityVerifier: {
      async verify() { throw new Error("authority changed"); },
    },
  });

  const pushEnvelope = envelopeFor("push");
  const pushCredential = recordingCredentialSource();
  const pushExecutor = createPullRequestExternalActionExecutor({
    enabledActions: ["push"],
    credentialSource: pushCredential.source,
    transport: mutableTransport(pushEnvelope),
    inputAuthorityVerifier: acceptingAuthority(pushEnvelope.action.inputBinding),
    controlledCommitVerifier: {
      async verify() { throw new Error("sealed evidence unavailable"); },
    },
  });

  assert.deepEqual(await staleExecutor.execute(staleEnvelope), { status: "stale" });
  assert.deepEqual(await pushExecutor.execute(pushEnvelope), {
    status: "error",
    error: {
      code: "CONTROLLED_COMMIT_VERIFIER_UNAVAILABLE",
      trust: "absent",
    },
  });
  assert.equal(staleCredential.calls.acquire.length, 0);
  assert.equal(pushCredential.calls.acquire.length, 0);
  assert.equal(timers.length, 4);
  assert.equal(cleared.length, timers.length);
  assert.deepEqual(new Set(cleared), new Set(timers));
});

test("lost response recovery proves completion after authority is revoked", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope, { loseResponse: true });
  let revoked = false;
  let authorityChecks = 0;
  const executor = executorFor(envelope, transport, {
    inputAuthorityVerifier: {
      async verify() {
        authorityChecks += 1;
        if (revoked) throw new Error("the PR Head changed before recovery");
        return structuredClone(envelope.action.inputBinding);
      },
    },
  });

  assert.equal((await executor.execute(envelope)).error.trust, "unknown");
  revoked = true;
  const callsBeforeRecovery = transport.calls.length;
  const checksBeforeRecovery = authorityChecks;

  assert.equal((await executor.reconcile(envelope)).status, "already");
  assert.equal(transport.calls.length, callsBeforeRecovery + 1);
  assert.equal(transport.calls.at(-1).method, "observe");
  assert.equal(
    transport.calls.filter(({ method }) => method === "perform").length,
    1,
  );
  assert.equal(authorityChecks, checksBeforeRecovery);
});

test("absent recovery proof checks revoked authority after one observation", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  const credential = recordingCredentialSource("runtime-secret");
  const executor = executorFor(envelope, transport, {
    credentialSource: credential.source,
    inputAuthorityVerifier: {
      async verify() {
        throw new Error("the PR Head changed before recovery");
      },
    },
  });

  assert.deepEqual(await executor.reconcile(envelope), { status: "stale" });
  assert.equal(credential.calls.acquire.length, 1);
  assert.deepEqual(
    transport.calls.map(({ method }) => method),
    ["observe"],
  );
});

test("recovery without credentials remains unknown and never performs", async () => {
  const envelope = envelopeFor("comment");
  const transport = mutableTransport(envelope);
  const executor = executorFor(envelope, transport, {
    credentialSource: Object.freeze({
      async acquire() {
        throw githubCredentialSourceError("GITHUB_CREDENTIAL_MISSING");
      },
    }),
  });

  assert.deepEqual(await executor.reconcile(envelope), {
    status: "error",
    error: { code: "GITHUB_CREDENTIAL_MISSING", trust: "unknown" },
  });
  assert.deepEqual(transport.calls, []);
});

test("authority revoked during the final observation is fenced before perform", async () => {
  const envelope = envelopeFor("comment");
  const base = mutableTransport(envelope);
  let observations = 0;
  let revoked = false;
  const transport = {
    calls: base.calls,
    async observe(input) {
      observations += 1;
      const result = await base.observe(input);
      if (observations === 2) revoked = true;
      return result;
    },
    perform: base.perform.bind(base),
  };
  const executor = executorFor(envelope, transport, {
    inputAuthorityVerifier: {
      async verify() {
        if (revoked) throw new Error("revoked while observing");
        return structuredClone(envelope.action.inputBinding);
      },
    },
  });

  assert.deepEqual(await executor.execute(envelope), { status: "stale" });
  assert.equal(observations, 2);
  assert.equal(transport.calls.some(({ method }) => method === "perform"), false);
});

test("push verifies sealed controlled evidence before any credential or transport call", async () => {
  const envelope = envelopeFor("push");
  const credential = recordingCredentialSource("secret");
  const transport = mutableTransport(envelope);
  const executor = executorFor(envelope, transport, {
    credentialSource: credential.source,
    controlledCommitVerifier: {
      async verify() {
        const changed = structuredClone(envelope.action.controlledCommitEvidence);
        changed.evidenceDigest = "0".repeat(64);
        return changed;
      },
    },
  });

  assert.deepEqual(await executor.execute(envelope), { status: "stale" });
  assert.equal(credential.calls.acquire.length, 0);
  assert.equal(transport.calls.length, 0);
});

test("push revalidates controlled evidence after the final observation before perform", async () => {
  for (const failure of ["mismatch", "unavailable"]) {
    const envelope = envelopeFor("push");
    const transport = mutableTransport(envelope);
    let evidenceChecks = 0;
    const executor = executorFor(envelope, transport, {
      controlledCommitVerifier: {
        async verify() {
          evidenceChecks += 1;
          if (evidenceChecks === 1) {
            return structuredClone(envelope.action.controlledCommitEvidence);
          }
          if (failure === "unavailable") {
            throw new Error("controlled evidence disappeared while observing");
          }
          const changed = structuredClone(
            envelope.action.controlledCommitEvidence,
          );
          changed.evidenceDigest = "0".repeat(64);
          return changed;
        },
      },
    });

    assert.deepEqual(
      await executor.execute(envelope),
      failure === "mismatch"
        ? { status: "stale" }
        : {
            status: "error",
            error: {
              code: "CONTROLLED_COMMIT_VERIFIER_UNAVAILABLE",
              trust: "absent",
            },
          },
      failure,
    );
    assert.equal(evidenceChecks, 2, failure);
    assert.deepEqual(
      transport.calls.map(({ method }) => method),
      ["observe", "observe"],
      failure,
    );
  }
});

test("push recovery uses sealed proof when the current evidence verifier is unavailable", async () => {
  const envelope = envelopeFor("push");
  const credential = recordingCredentialSource("secret");
  const transport = mutableTransport(envelope);
  transport.setObservation(completedObservation(envelope, "unused"));
  const executor = executorFor(envelope, transport, {
    credentialSource: credential.source,
    controlledCommitVerifier: {
      async verify() { throw new Error("sealed store temporarily unavailable"); },
    },
  });

  assert.equal((await executor.reconcile(envelope)).status, "already");
  assert.equal(credential.calls.acquire.length, 1);
  assert.deepEqual(
    transport.calls.map(({ method }) => method),
    ["observe"],
  );
});

test("update and merge completion proof fails closed when corrupted", async () => {
  const updateEnvelope = envelopeFor("update_branch");
  const updateTransport = mutableTransport(updateEnvelope);
  const wrongParents = completedObservation(updateEnvelope, "unused");
  wrongParents.actionEvidence.commit.parents.reverse();
  updateTransport.setObservation(wrongParents);
  assert.deepEqual(
    await executorFor(updateEnvelope, updateTransport).reconcile(updateEnvelope),
    { status: "stale" },
  );

  const mergeEnvelope = envelopeFor("merge");
  const mergeTransport = mutableTransport(mergeEnvelope);
  const missingMarker = completedObservation(
    mergeEnvelope,
    `<!-- mydashboard-action:v1:${"f".repeat(64)} -->`,
  );
  mergeTransport.setObservation(missingMarker);
  assert.deepEqual(
    await executorFor(mergeEnvelope, mergeTransport).reconcile(mergeEnvelope),
    {
      status: "error",
      error: { code: "GITHUB_COMPLETION_PROOF_CONFLICT", trust: "unknown" },
    },
  );
});
