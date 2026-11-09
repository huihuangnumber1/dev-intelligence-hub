import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_JOB_ACTIONS_BY_OPERATION,
  createCodeJobGrant,
  createQueuedCodeJob,
} from "../src/domain/code-job-contract.js";
import { createConflictPreparationBinding } from "../src/domain/conflict-preparation-binding.js";
import { createConflictCodeExecutionSource } from "../src/domain/code-execution-source.js";
import {
  normalizeCodeJobBrowserProjection,
  projectCodeJobObservationForBrowser,
  projectNormalizedCodeJobForBrowser,
} from "../src/domain/code-job-browser-projection.js";

const HEAD_REF_OID = "1".repeat(40);

function inputBinding() {
  return {
    schemaVersion: 1,
    kind: "pull_request",
    repository: "acme/widgets",
    pullRequestNumber: 17,
    rootItemId: "github:acme/widgets:pull-request:17",
    workKey: "github:acme/widgets:pull-request:17",
    inputRevision: 3,
    headRevision: 2,
    headRefOid: HEAD_REF_OID,
    eventId: "event-1",
    eventDigest: "2".repeat(64),
    inputDigest: "3".repeat(64),
  };
}

function conflictInputBinding() {
  const gitTarget = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/widgets",
    baseRefName: "main",
    baseRefOid: "4".repeat(40),
    headRepository: "contributor/widgets",
    headRefName: "fix/conflict",
    headRefOid: HEAD_REF_OID,
  };
  return { ...inputBinding(), schemaVersion: 2, gitTarget };
}

function conflictExecutionSource(binding) {
  return createConflictCodeExecutionSource({
    inputBinding: binding,
    preparationBinding: createConflictPreparationBinding({
      preparation: {
        schemaVersion: 1,
        preparationId: "5".repeat(64),
        status: "conflicted",
        baseCommitOid: binding.gitTarget.baseRefOid,
        headCommitOid: binding.gitTarget.headRefOid,
        mergeBaseOid: "6".repeat(40),
        resultTreeOid: "7".repeat(40),
        conflicts: [{ path: "src/app.js", mode: "100644" }],
        boundaryDigest: "8".repeat(64),
        evidenceDigest: "9".repeat(64),
        resultObjectDigest: "f".repeat(64),
        materialization: "full-tree",
      },
      gitTarget: binding.gitTarget,
    }),
  });
}

function grant({ bound, conflict = false, operation: requestedOperation }) {
  const binding = conflict ? conflictInputBinding() : inputBinding();
  const executionSource = conflict ? conflictExecutionSource(binding) : null;
  const operation = requestedOperation ?? (conflict ? "modify" : "inspect");
  const content = {
    proposalId: "work-intent-proposal-1",
    contentDigest: "a".repeat(64),
    policyVersion: 7,
    requestedBy: { roleId: "developer", workItemId: "work-1" },
    source: { assignmentId: "assignment-1", eventId: "event-1" },
    subject: {
      id: "github:acme/widgets:pull-request:17",
      repository: "acme/widgets",
      number: 17,
    },
    repository: "acme/widgets",
    workspaceId: "widgets-local",
    workspaceAuthorityDigest: "9".repeat(64),
    operation,
    objective: "Inspect the retry race",
    acceptanceCriteria: ["Explain the failure"],
    evidence: ["A trusted workflow event requested diagnosis"],
    summary: "Inspect the retry race",
    reason: "A trusted workflow event requested diagnosis.",
    allowedActions: [...CODE_JOB_ACTIONS_BY_OPERATION[operation]],
    writablePaths: conflict ? ["src/app.js"] : operation === "modify" ? ["src"] : [],
    requiredProfiles: [
      { id: "node-tests", configDigest: "b".repeat(64) },
    ],
    brainDigest: "c".repeat(64),
  };
  return createCodeJobGrant(
    conflict
      ? { schemaVersion: 3, ...content, inputBinding: binding, executionSource }
      : bound
      ? { schemaVersion: 2, ...content, inputBinding: binding }
      : content,
  );
}

function queuedJob({ bound, conflict = false, operation }) {
  return createQueuedCodeJob(
    {
      confirmationId: "confirmation-code-job-approval-1",
      requestId: "approval-request-0001",
      displayedPayloadDigest: "d".repeat(64),
      approvalBindingDigest: "e".repeat(64),
      grant: grant({ bound, conflict, operation }),
    },
    {
      sequence: 1,
      revision: 1,
      createdAt: "2026-08-02T06:00:00.000Z",
    },
  );
}

test("v2 browser projection preserves the exact pull request input binding", () => {
  const projection = projectNormalizedCodeJobForBrowser(
    queuedJob({ bound: true }),
  );

  assert.equal(projection.repository, "acme/widgets");
  assert.equal(projection.subject.number, 17);
  assert.deepEqual(projection.inputBinding, inputBinding());
  assert.equal(projection.inputBinding.headRefOid, HEAD_REF_OID);
  assert.deepEqual(normalizeCodeJobBrowserProjection(projection), projection);
});

test("v2 browser projection rejects repository and pull request mismatches", () => {
  const projection = projectNormalizedCodeJobForBrowser(
    queuedJob({ bound: true }),
  );
  const wrongRepository = structuredClone(projection);
  wrongRepository.inputBinding.repository = "acme/other";
  const wrongPullRequest = structuredClone(projection);
  wrongPullRequest.inputBinding.pullRequestNumber = 18;

  for (const candidate of [wrongRepository, wrongPullRequest]) {
    assert.throws(
      () => normalizeCodeJobBrowserProjection(candidate),
      TypeError,
    );
  }
});

test("v3 browser projection preserves the sealed conflict source", () => {
  const projection = projectNormalizedCodeJobForBrowser(
    queuedJob({ bound: true, conflict: true }),
  );
  const binding = conflictInputBinding();

  assert.deepEqual(projection.inputBinding, binding);
  assert.deepEqual(
    projection.executionSource,
    conflictExecutionSource(binding),
  );
  assert.deepEqual(projection.writablePaths, ["src/app.js"]);
  assert.deepEqual(normalizeCodeJobBrowserProjection(projection), projection);

  const changed = structuredClone(projection);
  changed.executionSource.writeScope.paths = ["src/other.js"];
  assert.throws(() => normalizeCodeJobBrowserProjection(changed), TypeError);
});

test("legacy browser projections remain readable without an input binding", () => {
  const projection = projectNormalizedCodeJobForBrowser(
    queuedJob({ bound: false }),
  );

  assert.equal(Object.hasOwn(projection, "inputBinding"), false);
  assert.deepEqual(normalizeCodeJobBrowserProjection(projection), projection);
});

test("browser profile observations retain bounded test counts without logs or extra summary fields", () => {
  const summary = { total: 3, passed: 1, failed: 1, cancelled: 0, skipped: 1, todo: 0, executed: 2 };
  const observation = {
    turn: 1, actionId: "profile-summary", actionType: "run_profile",
    action: { profileId: "node-tests" }, actionDigest: "1".repeat(64),
    status: "failed", workspaceRevision: "2".repeat(64), detailDigest: "3".repeat(64),
    detail: { schemaVersion: 1, result: { exitCode: 1, stdout: "private test output", testSummary: { ...summary, testNames: ["x".repeat(100_000)] } } },
    recordedAt: "2026-08-02T06:00:01.000Z",
  };

  const projected = projectCodeJobObservationForBrowser(observation);

  assert.deepEqual(projected.detail.result.testSummary, summary);
  assert.equal(Object.hasOwn(projected.detail.result, "stdout"), false);
  observation.detail.result.testSummary.executed = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(Object.hasOwn(projectCodeJobObservationForBrowser(observation).detail.result, "testSummary"), false);
});

function failedVerificationJob(code, operation = "verify") {
  const job = queuedJob({ bound: true, operation });
  job.status = "failed";
  job.revision = 2;
  job.updatedAt = "2026-08-02T06:00:01.000Z";
  job.execution.result = {
    kind: "failed",
    detail: { schemaVersion: 1, code, message: "private provider error and logs" },
  };
  return job;
}

test("verification outcome projection exposes only four safe failed-verify categories", () => {
  for (const code of [
    "CODE_JOB_VERIFICATION_FAILED",
    "CODE_JOB_VERIFICATION_TIMEOUT",
    "CODE_JOB_VERIFICATION_ENVIRONMENT_UNAVAILABLE",
    "CODE_JOB_VERIFICATION_UNKNOWN",
  ]) {
    const projection = projectNormalizedCodeJobForBrowser(failedVerificationJob(code));

    assert.equal(projection.verificationOutcome, code);
    assert.deepEqual(projection.terminalResult, { kind: "failed", recordedAt: "2026-08-02T06:00:01.000Z" });
    assert.equal(JSON.stringify(projection).includes("private provider error"), false);
    assert.deepEqual(normalizeCodeJobBrowserProjection(projection), projection);
    const oldProjection = structuredClone(projection);
    delete oldProjection.verificationOutcome;
    assert.deepEqual(normalizeCodeJobBrowserProjection(oldProjection), oldProjection);
  }
  for (const job of [
    failedVerificationJob("UNCLASSIFIED_PROVIDER_FAILURE"),
    failedVerificationJob("CODE_JOB_VERIFICATION_FAILED", "inspect"),
    failedVerificationJob("CODE_JOB_VERIFICATION_FAILED", "modify"),
    queuedJob({ bound: true, operation: "verify" }),
  ]) {
    assert.equal(Object.hasOwn(projectNormalizedCodeJobForBrowser(job), "verificationOutcome"), false);
  }
});

test("verification outcome normalization rejects incompatible state, unknown categories, and binding tampering", () => {
  const valid = projectNormalizedCodeJobForBrowser(failedVerificationJob("CODE_JOB_VERIFICATION_FAILED"));
  const invalid = [
    { ...valid, verificationOutcome: "arbitrary provider output" },
    { ...valid, verificationOutcome: null },
    { ...valid, operation: "modify" },
    { ...valid, status: "completed", terminalResult: { ...valid.terminalResult, kind: "completed" } },
    { ...valid, inputBinding: { ...valid.inputBinding, repository: "acme/other" } },
    { ...projectNormalizedCodeJobForBrowser(queuedJob({ bound: true, operation: "verify" })), verificationOutcome: "CODE_JOB_VERIFICATION_FAILED" },
  ];
  for (const candidate of invalid) {
    assert.throws(() => normalizeCodeJobBrowserProjection(candidate), TypeError);
  }
});
