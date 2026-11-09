import { createHash } from "node:crypto";

import { createChangePackage } from "../../src/domain/change-package-contract.js";
import { createConflictCodeExecutionSource, createReviewRepairCodeExecutionSource } from "../../src/domain/code-execution-source.js";
import { createConflictPreparationBinding } from "../../src/domain/conflict-preparation-binding.js";
import { normalizeConfirmationPlan } from "../../src/domain/confirmation-contract.js";
import {
  createControlledCommitEvidence,
  createControlledCommitMessage,
} from "../../src/domain/controlled-commit-evidence.js";
import { createPullRequestExternalActionConfirmationPlan } from "../../src/domain/pull-request-external-action.js";
import { normalizeBoundWorkProposal } from "../../src/domain/work-proposal-contract.js";

export const EXTERNAL_ACTION_CREATED_AT = "2026-08-08T06:07:08.901Z";

export function externalActionOid(character) {
  return character.repeat(40);
}

export function pullRequestExternalActionBinding(overrides = {}) {
  const target = {
    schemaVersion: 1,
    provider: "github",
    sourceAccountId: "runtime-user",
    baseRepository: "acme/repo",
    baseRefName: "main",
    baseRefOid: externalActionOid("1"),
    headRepository: "contributor/repo",
    headRefName: "fix/conflict",
    headRefOid: externalActionOid("2"),
    ...overrides.gitTarget,
  };
  return {
    schemaVersion: 2,
    kind: "pull_request",
    repository: target.baseRepository,
    pullRequestNumber: 42,
    rootItemId: "github:pr:acme/repo#42",
    workKey: "pr:acme/repo#42",
    inputRevision: 3,
    headRevision: 5,
    headRefOid: target.headRefOid,
    eventId: "github-event-42",
    eventDigest: "3".repeat(64),
    inputDigest: "4".repeat(64),
    ...overrides,
    gitTarget: target,
  };
}

export function externalActionControlledCommit(
  binding = pullRequestExternalActionBinding(),
  { reviewRepair = false } = {},
) {
  const paths = ["src/conflicted.js"];
  const preparationBinding = createConflictPreparationBinding({
    gitTarget: binding.gitTarget,
    preparation: {
      schemaVersion: 1,
      preparationId: "5".repeat(64),
      status: "conflicted",
      baseCommitOid: binding.gitTarget.baseRefOid,
      headCommitOid: binding.gitTarget.headRefOid,
      mergeBaseOid: externalActionOid("3"),
      resultTreeOid: externalActionOid("4"),
      conflicts: paths.map((path) => ({ path, mode: "100644" })),
      boundaryDigest: "6".repeat(64),
      evidenceDigest: "7".repeat(64),
      resultObjectDigest: "8".repeat(64),
      materialization: "full-tree",
    },
  });
  const source = reviewRepair ? createReviewRepairCodeExecutionSource({ inputBinding: binding, writablePaths: ["src"] }) : createConflictCodeExecutionSource({
    inputBinding: binding,
    preparationBinding,
  });
  const workspace = {
    id: "workspace-1",
    sourceRevision: "a".repeat(64),
    workspaceRevision: "b".repeat(64),
  };
  const artifact = (kind, marker) => ({
    path: `session-1/node-tests/${kind}.json`,
    sha256: marker.repeat(64),
    bytes: 12,
  });
  const manifest = createChangePackage({
    job: { id: "code-job-1", revision: 7, recordDigest: "9".repeat(64) },
    proposal: { id: "proposal-1", contentDigest: "a".repeat(64) },
    grant: { digest: "b".repeat(64) },
    workspace,
    passedProfiles: [{
      id: "node-tests",
      configDigest: "c".repeat(64),
      workspaceRevision: workspace.workspaceRevision,
      actionId: "action-node-tests",
      attemptNumber: 2,
      imageId: "sha256:image-node-tests",
      artifacts: {
        output: artifact("output", "c"),
        stdout: artifact("stdout", "d"),
        stderr: artifact("stderr", "e"),
      },
    }],
    created: [],
    modified: [{
      path: paths[0],
      beforeSha256: "f".repeat(64),
      content: Buffer.from("resolved\n", "utf8"),
    }],
    deleted: [],
  }).manifest;
  const finalTreeOid = externalActionOid("5");
  const timestamp = Math.floor(Date.parse(EXTERNAL_ACTION_CREATED_AT) / 1_000);
  const identity = {
    name: "MyDashboard PR Engineer",
    email: "pr-engineer@mydashboard.local",
    timestamp,
    timezone: "+0000",
  };
  const messageDigest = createHash("sha256")
    .update(createControlledCommitMessage({ executionSource: source, manifest }), "utf8")
    .digest("hex");
  return createControlledCommitEvidence({
    executionSource: source,
    manifest,
    resolution: { resolvedPaths: paths, finalTreeOid },
    commit: {
      objectFormat: "sha1",
      oid: externalActionOid("6"),
      treeOid: finalTreeOid,
      parents: reviewRepair ? [binding.gitTarget.headRefOid] : [binding.gitTarget.headRefOid, binding.gitTarget.baseRefOid],
      author: { ...identity },
      committer: { ...identity },
      messageDigest,
      objectSetDigest: "e".repeat(64),
    },
    createdAt: EXTERNAL_ACTION_CREATED_AT,
  });
}

export function pullRequestExternalActionProposal(
  action,
  {
    binding = pullRequestExternalActionBinding(),
    proposalId = `proposal-${action.type.replaceAll("_", "-")}`,
  } = {},
) {
  return normalizeBoundWorkProposal({
    proposalId,
    policyVersion: 1,
    kind: "github_pull_request_action_proposal",
    requestedBy: { roleId: "pr-engineer", workItemId: "work-item-42" },
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
      action,
      summary: `执行 ${action.type}`,
      reason: "系统已完成安全检查",
      evidence: ["event:github-event-42"],
    },
  });
}

export function pullRequestExternalActionPlan(action, options) {
  return normalizeConfirmationPlan(
    pullRequestExternalActionQueuePlan(action, options),
  );
}

export function pullRequestExternalActionQueuePlan(action, options) {
  return createPullRequestExternalActionConfirmationPlan(
    pullRequestExternalActionProposal(action, options),
    { actorAccountId: "runtime-user" },
  );
}

export function pullRequestExternalActionEnvelope(plan, overrides = {}) {
  return {
    schemaVersion: 1,
    id: plan.id,
    idempotencyKey: `confirmation-${plan.approvalBindingDigest}`,
    kind: plan.kind,
    requestedBy: plan.requestedBy,
    actor: plan.actor,
    target: plan.target,
    action: plan.action,
    displayedPayloadDigest: plan.displayedPayloadDigest,
    approvalBindingDigest: plan.approvalBindingDigest,
    execution: {
      requestId: "request-confirm-pr-action-0001",
      attempt: 1,
      startedAt: EXTERNAL_ACTION_CREATED_AT,
    },
    ...overrides,
  };
}
