import { createHash } from "node:crypto";
import { normalizeConfirmationPlan } from "./confirmation-contract.js";
import { normalizePullRequestExecutionBinding } from "./pull-request-execution-binding.js";
import { normalizePublishedReviewReuse } from "./review-result-proof.js";
import {
  assertWorkProposalAuthorityBinding,
  assertWorkProposalExactKeys,
  normalizeBoundWorkProposal,
  normalizeWorkProposalDigest,
  workProposalError,
} from "./work-proposal-contract.js";

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const HEAD_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REVIEW_EVENTS = Object.freeze({
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
});

function invalid(message = "GitHub Review 工作提案无法进入确认队列") {
  return workProposalError("INVALID_GITHUB_REVIEW_PROPOSAL", message);
}

function plainRecord(value, keys, name) {
  assertWorkProposalExactKeys(value, keys, invalid(`${name} 无效`));
  return value;
}

function text(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern && !pattern.test(value))
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function evidence(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 20 ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid("payload.evidence 无效");
  }
  return value.map((entry) => text(entry, "payload.evidence", 2_048));
}

function normalizedStoredProposal(value) {
  assertWorkProposalExactKeys(
    value,
    [
      "proposalId",
      "contentDigest",
      "policyVersion",
      "kind",
      "requestedBy",
      "source",
      "binding",
      "payload",
    ],
    invalid(),
  );
  const normalized = normalizeBoundWorkProposal({
    proposalId: value.proposalId,
    policyVersion: value.policyVersion,
    kind: value.kind,
    requestedBy: value.requestedBy,
    source: value.source,
    binding: value.binding,
    payload: value.payload,
  });
  if (
    normalizeWorkProposalDigest(value.contentDigest, invalid()) !==
    normalized.contentDigest
  ) {
    throw invalid("工作提案摘要不匹配");
  }
  return normalized;
}

function queuePlan(value) {
  let normalized;
  try {
    normalized = normalizeConfirmationPlan(value);
  } catch (error) {
    if (error?.code === "INVALID_CONFIRMATION_REQUEST") {
      throw invalid("确认计划超过容量或格式限制");
    }
    throw error;
  }
  const {
    displayedPayloadDigest: _displayedPayloadDigest,
    approvalBindingDigest: _approvalBindingDigest,
    ...plan
  } = normalized;
  return plan;
}

function confirmationId(proposal, selfReviewVersion) {
  const digest = createHash("sha256")
    .update(proposal.proposalId, "utf8")
    .update("\0", "utf8")
    .update(proposal.contentDigest, "utf8")
    .update(
      selfReviewVersion === 2
        ? "\0self-authored-lifecycle-v2"
        : selfReviewVersion === 1 ? "\0self-authored-comment-v1" : "",
      "utf8",
    )
    .digest("hex");
  return `confirmation-github-review-${digest}`;
}

export function createGitHubReviewProposalConfirmationPlan(
  value,
  {
    actorAccountId,
    legacyRecovery = false,
    selfAuthored = false,
    legacySelfAuthored = false,
    legacyUnversionedSelfAuthored = false,
    publishedReviewReuse = null,
  } = {},
) {
  if (
    typeof selfAuthored !== "boolean" ||
    typeof legacySelfAuthored !== "boolean" ||
    typeof legacyUnversionedSelfAuthored !== "boolean" ||
    [selfAuthored, legacySelfAuthored, legacyUnversionedSelfAuthored]
      .filter(Boolean).length > 1
  ) {
    throw invalid("selfAuthored 无效");
  }
  const proposal = normalizedStoredProposal(value);
  if (proposal.kind !== "github_review_proposal") {
    throw invalid("工作提案类型无效");
  }
  const binding = plainRecord(
    proposal.binding,
    [
      "eventId",
      "subject",
      "repository",
      "pullRequestNumber",
      "headRefOid",
      "inputBinding",
      ...(Object.hasOwn(proposal.binding, "evidenceTarget")
        ? ["evidenceTarget"]
        : []),
      ...(Object.hasOwn(proposal.binding, "dispatchIntentId")
        ? ["dispatchIntentId"]
        : []),
    ],
    "binding",
  );
  assertWorkProposalAuthorityBinding(
    proposal,
    binding,
    invalid("binding 权威信息无效"),
  );
  const payload = plainRecord(
    proposal.payload,
    ["verdict", "body", "evidence", "summary", "reason", ...(publishedReviewReuse ? ["publicationReuse"] : [])],
    "payload",
  );
  const eventId = text(binding.eventId, "binding.eventId", 256);
  if (eventId !== proposal.source.eventId) {
    throw invalid("binding.eventId 与 source.eventId 不一致");
  }
  const repository = text(binding.repository, "binding.repository", 140, REPOSITORY);
  const number = binding.pullRequestNumber;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw invalid("binding.pullRequestNumber 无效");
  }
  const subject = plainRecord(
    binding.subject,
    Object.hasOwn(binding.subject, "id")
      ? ["id", "repository", "number"]
      : ["repository", "number"],
    "binding.subject",
  );
  if (subject.id !== undefined) {
    text(subject.id, "binding.subject.id", 512);
  }
  const subjectRepository = text(
    subject.repository,
    "binding.subject.repository",
    140,
    REPOSITORY,
  );
  if (
    subjectRepository !== repository ||
    !Number.isSafeInteger(subject.number) ||
    subject.number !== number
  ) {
    throw invalid("binding.subject 与 PR 绑定不一致");
  }
  const headRefOid = text(binding.headRefOid, "binding.headRefOid", 64, HEAD_OID);
  let inputBinding;
  try {
    inputBinding = normalizePullRequestExecutionBinding(
      binding.inputBinding,
      invalid("binding.inputBinding 无效"),
    );
  } catch {
    throw invalid("binding.inputBinding 无效");
  }
  if (inputBinding.schemaVersion === 1 && legacyRecovery !== true) {
    throw invalid("旧版 Review 提案只允许恢复，不得新建确认");
  }
  if (
    inputBinding.repository !== repository ||
    inputBinding.pullRequestNumber !== number ||
    inputBinding.headRefOid !== headRefOid ||
    inputBinding.eventId !== eventId
  ) {
    throw invalid("binding.inputBinding 与 Review 目标不匹配");
  }
  const proposedReviewEvent = REVIEW_EVENTS[payload.verdict];
  if (!proposedReviewEvent) throw invalid("payload.verdict 无效");
  const selfReview =
    selfAuthored || legacySelfAuthored || legacyUnversionedSelfAuthored;
  const downgradedSelfReview =
    selfReview && proposedReviewEvent !== "COMMENT";
  const reviewEvent = downgradedSelfReview ? "COMMENT" : proposedReviewEvent;
  const body = text(payload.body, "payload.body", 16 * 1_024);
  const summary = text(payload.summary, "payload.summary", 2_048);
  const reasons = evidence(payload.evidence);
  const displayEvidence = downgradedSelfReview
    ? [
        ...reasons.slice(0, 19),
        "GitHub 不允许 PR 作者批准或请求修改自己的 PR；本次将以 COMMENT Review 发布。",
      ]
    : reasons;
  const accountId = text(
    actorAccountId,
    "actorAccountId",
    39,
    GITHUB_LOGIN,
  );
  if (
    inputBinding.schemaVersion === 2 &&
    inputBinding.gitTarget.sourceAccountId.toLowerCase() !==
    accountId.toLowerCase()
  ) {
    throw invalid("GitHub 执行账号与 PR 观察账号不一致");
  }
  const actor = { provider: "github", accountId };
  const target = {
    provider: "github",
    resourceId: `${repository}#${number}`,
    version: headRefOid,
  };
  const action = inputBinding.schemaVersion === 2
    ? {
        type: "pull_request_review",
        reviewEvent,
        body,
        inputBinding,
        ...(publishedReviewReuse ? { publishedReviewReuse: normalizePublishedReviewReuse(publishedReviewReuse) } : {}),
      }
    : { type: "pull_request_review", reviewEvent, body };

  return queuePlan({
    id: confirmationId(
      proposal,
      selfAuthored ? 2 : legacySelfAuthored ? 1 : 0,
    ),
    kind: "github.work-proposal-review",
    requestedBy: proposal.requestedBy,
    actor,
    target,
    action,
    display: {
      title: `${repository} #${number} · 岗位 Review 提案`,
      summary,
      actionLabel: publishedReviewReuse ? "确认复用评审并推进当前任务" : downgradedSelfReview
        ? "确认并以 COMMENT 发布到 GitHub"
        : "确认并发布到 GitHub",
      evidence: displayEvidence,
      payload: {
        actor,
        target,
        action,
        ...(inputBinding.schemaVersion === 2 ? {} : { inputBinding }),
        ...(selfAuthored ? { reviewIntent: proposedReviewEvent } : {}),
      },
    },
  });
}


// All historical proof consumers reconstruct the same supported plan variants.
// These plans prove past publication only; they do not grant current authority.
export function historicalGitHubReviewConfirmationPlans(proposal, actorAccountId) {
  return [{}, { selfAuthored: true }, { legacySelfAuthored: true }, { legacyUnversionedSelfAuthored: true }]
    .map(variant => normalizeConfirmationPlan(createGitHubReviewProposalConfirmationPlan(proposal,
      { actorAccountId, legacyRecovery: true, ...variant })));
}
