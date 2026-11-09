import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfirmationPlan } from "../src/domain/confirmation-contract.js";
import { createGitHubReviewProposalConfirmationPlan } from "../src/domain/github-review-proposal-confirmation.js";
import { markerForGitHubAction } from "../src/adapters/github-action-adapter.js";
import {
  PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS,
  createPullRequestExternalActionConfirmationPlan,
  normalizePullRequestExternalActionEnvelope,
  pullRequestExternalActionMarker,
} from "../src/domain/pull-request-external-action.js";
import { normalizeBoundWorkProposal } from "../src/domain/work-proposal-contract.js";
import {
  EXTERNAL_ACTION_CREATED_AT as CREATED_AT,
  externalActionControlledCommit as controlledCommitEvidence,
  externalActionOid as oid,
  pullRequestExternalActionBinding as inputBinding,
  pullRequestExternalActionEnvelope as executionEnvelope,
  pullRequestExternalActionPlan as planFor,
  pullRequestExternalActionProposal as proposal,
} from "./support/pull-request-external-action-fixture.js";

test("creates separately approved, fully displayed plans for every PR action", () => {
  const binding = inputBinding();
  const actions = [
    { type: "comment", body: "Please add a regression test." },
    { type: "review", verdict: "request_changes", body: "Blocking issue." },
    { type: "update_branch" },
    { type: "push", controlledCommitEvidence: controlledCommitEvidence(binding) },
    { type: "merge", method: "squash" },
  ];

  const plans = actions.map((action) => planFor(action, { binding }));

  assert.deepEqual(
    plans.map(({ kind }) => kind),
    [
      PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.comment,
      PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.review,
      PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.update_branch,
      PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.push,
      PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.merge,
    ],
  );
  assert.equal(new Set(plans.map(({ approvalBindingDigest }) => approvalBindingDigest)).size, 5);
  for (const plan of plans) {
    assert.deepEqual(plan.display.payload, {
      actor: plan.actor,
      target: plan.target,
      action: plan.action,
    });
    const displayed = JSON.stringify(plan.display.payload);
    for (const expected of [
      "runtime-user",
      "acme/repo#42",
      binding.headRefOid,
      binding.gitTarget.baseRefName,
      binding.gitTarget.baseRefOid,
      binding.gitTarget.headRepository,
      binding.gitTarget.headRefName,
      binding.eventId,
      binding.eventDigest,
      binding.inputDigest,
    ]) {
      assert.match(displayed, new RegExp(expected));
    }
  }
  assert.match(JSON.stringify(plans[0].display.payload), /regression test/);
  assert.match(
    JSON.stringify(plans[3].display.payload),
    new RegExp(actions[3].controlledCommitEvidence.evidenceId),
  );
});

test("review repair original-branch push accepts only its exact single-parent evidence", () => {
  const binding = inputBinding();
  const evidence = controlledCommitEvidence(binding, { reviewRepair: true });
  const plan = planFor({ type: "push", controlledCommitEvidence: evidence }, { binding });
  assert.deepEqual(plan.action.controlledCommitEvidence.commit.parents, [binding.headRefOid]);
  assert.equal(plan.action.remote.refName, binding.gitTarget.headRefName);
  assert.deepEqual(normalizePullRequestExternalActionEnvelope(executionEnvelope(plan)).action, plan.action);
  assert.throws(() => planFor({ type: "push", controlledCommitEvidence: evidence }, {
    binding: inputBinding({ inputRevision: binding.inputRevision + 1 }),
  }));
});

test("generic Review keeps the existing work-proposal Review execution contract", () => {
  const binding = inputBinding();
  const generic = planFor({
    type: "review",
    verdict: "approve",
    body: "Looks good.",
  }, { binding });
  const legacyProposal = normalizeBoundWorkProposal({
    proposalId: "proposal-legacy-review",
    policyVersion: 1,
    kind: "github_review_proposal",
    requestedBy: generic.requestedBy,
    source: { assignmentId: "assignment-42", eventId: binding.eventId },
    binding: {
      eventId: binding.eventId,
      subject: {
        id: "github:pr:acme/repo#42",
        repository: binding.repository,
        number: binding.pullRequestNumber,
      },
      repository: binding.repository,
      pullRequestNumber: binding.pullRequestNumber,
      headRefOid: binding.headRefOid,
      inputBinding: binding,
    },
    payload: {
      verdict: "approve",
      body: "Looks good.",
      evidence: ["event:github-event-42"],
      summary: "Review complete",
      reason: "Ready",
    },
  });
  const legacy = normalizeConfirmationPlan(
    createGitHubReviewProposalConfirmationPlan(legacyProposal, {
      actorAccountId: "runtime-user",
    }),
  );

  assert.equal(generic.kind, legacy.kind);
  assert.deepEqual(generic.actor, legacy.actor);
  assert.deepEqual(generic.target, legacy.target);
  assert.deepEqual(generic.action, legacy.action);
  for (const plan of [generic, legacy]) {
    const envelope = executionEnvelope(plan);
    assert.equal(
      pullRequestExternalActionMarker(envelope),
      markerForGitHubAction(envelope),
    );
  }
});

test("normalizes a queue envelope and rejects approval or target corruption", () => {
  const plan = planFor({ type: "comment", body: "Bound comment." });
  const envelope = executionEnvelope(plan);

  assert.deepEqual(normalizePullRequestExternalActionEnvelope(envelope), envelope);
  assert.match(
    pullRequestExternalActionMarker(envelope),
    /^<!-- mydashboard-action:v1:[a-f0-9]{64} -->$/,
  );

  for (const corrupt of [
    { ...envelope, approvalBindingDigest: "0".repeat(64) },
    { ...envelope, actor: { ...envelope.actor, accountId: "other-user" } },
    { ...envelope, target: { ...envelope.target, version: oid("9") } },
    {
      ...envelope,
      action: {
        ...envelope.action,
        inputBinding: {
          ...envelope.action.inputBinding,
          eventDigest: "9".repeat(64),
        },
      },
    },
  ]) {
    assert.throws(() => normalizePullRequestExternalActionEnvelope(corrupt));
  }
});

test("rejects v1 bindings, account drift, and controlled evidence from another PR state", () => {
  const v2 = inputBinding();
  const { gitTarget: _gitTarget, ...legacy } = v2;
  legacy.schemaVersion = 1;

  assert.throws(() => planFor({ type: "comment", body: "x" }, { binding: legacy }));
  assert.throws(() =>
    createPullRequestExternalActionConfirmationPlan(
      proposal({ type: "comment", body: "x" }),
      { actorAccountId: "other-user" },
    ));

  const changed = inputBinding({
    gitTarget: { headRefOid: oid("9") },
    headRefOid: oid("9"),
    headRevision: 6,
  });
  assert.throws(() =>
    planFor({
      type: "push",
      controlledCommitEvidence: controlledCommitEvidence(v2),
    }, { binding: changed }),
  );

  const evidence = structuredClone(controlledCommitEvidence(v2));
  evidence.evidenceDigest = "0".repeat(64);
  assert.throws(() =>
    planFor({ type: "push", controlledCommitEvidence: evidence }, { binding: v2 }),
  );
});
