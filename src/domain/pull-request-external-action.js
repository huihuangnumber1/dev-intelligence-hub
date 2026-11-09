import { createHash } from "node:crypto";
import { normalizePublishedReviewReuse } from "./review-result-proof.js";
import { isHeadRepairExecutionSource } from "./code-execution-source.js";
import { types as utilTypes } from "node:util";

import { normalizeConfirmationPlan } from "./confirmation-contract.js";
import {
  normalizeControlledCommitEvidence,
  sameControlledCommitEvidence,
} from "./controlled-commit-evidence.js";
import { digestValue } from "./code-executor-contract.js";
import {
  normalizePullRequestExecutionBinding,
  samePullRequestExecutionBinding,
} from "./pull-request-execution-binding.js";
import {
  assertWorkProposalAuthorityBinding,
  assertWorkProposalExactKeys,
  normalizeBoundWorkProposal,
  normalizeWorkProposalDigest,
  workProposalError,
} from "./work-proposal-contract.js";

const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/u;
const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/iu;
const REQUEST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{6,126}[A-Za-z0-9])$/u;
const MARKER_PREFIX = "mydashboard-action:v1";
const PROPOSAL_KIND = "github_pull_request_action_proposal";
const REVIEW_EVENTS = Object.freeze({
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
});
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);

export const PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS = Object.freeze({
  comment: "github.pull-request-comment",
  review: "github.work-proposal-review",
  update_branch: "github.pull-request-update-branch",
  push: "github.pull-request-push",
  merge: "github.pull-request-merge",
});

const ACTION_BY_KIND = Object.freeze({
  [PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.comment]: "pull_request_comment",
  [PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.review]: "pull_request_review",
  [PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.update_branch]:
    "pull_request_update_branch",
  [PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.push]: "pull_request_push",
  [PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS.merge]: "pull_request_merge",
});

export class PullRequestExternalActionError extends Error {
  constructor(message = "GitHub PR 外部动作无效", options) {
    super(message, options);
    this.name = "PullRequestExternalActionError";
    this.code = "INVALID_PULL_REQUEST_EXTERNAL_ACTION";
  }
}

function invalid(message, cause) {
  return new PullRequestExternalActionError(
    message,
    cause === undefined ? undefined : { cause },
  );
}

function proposalInvalid(message) {
  return workProposalError(
    "INVALID_GITHUB_PULL_REQUEST_ACTION_PROPOSAL",
    message || "GitHub PR 外部动作提案无法进入确认队列",
  );
}

function exact(value, keys, name, error = invalid(`${name} 无效`)) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw error;
  }
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key)) ||
    actual.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key !== "string" || !descriptor?.enumerable ||
        !("value" in descriptor);
    })
  ) {
    throw error;
  }
  return value;
}

function boundedText(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function canonicalTimestamp(value, name) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw invalid(`${name} 无效`);
  }
  return value;
}

function denseTextArray(value, name) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 20 ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid(`${name} 无效`);
  }
  return value.map((entry) => boundedText(entry, name, 2_048));
}

function clone(value) {
  return structuredClone(value);
}

function normalizeStoredProposal(value) {
  const error = proposalInvalid();
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
    error,
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
    normalized.kind !== PROPOSAL_KIND ||
    normalizeWorkProposalDigest(value.contentDigest, error) !==
      normalized.contentDigest
  ) {
    throw error;
  }
  return normalized;
}

function normalizeBinding(proposal) {
  const error = proposalInvalid("GitHub PR 外部动作提案绑定无效");
  const binding = proposal.binding;
  const optionalKeys = ["evidenceTarget", "dispatchIntentId"].filter((key) =>
    Object.hasOwn(binding, key)
  );
  assertWorkProposalExactKeys(
    binding,
    [
      "eventId",
      "subject",
      "repository",
      "pullRequestNumber",
      "headRefOid",
      "inputBinding",
      ...optionalKeys,
    ],
    error,
  );
  assertWorkProposalAuthorityBinding(proposal, binding, error);
  const eventId = boundedText(binding.eventId, "binding.eventId", 256);
  if (eventId !== proposal.source.eventId) throw error;
  const repository = boundedText(
    binding.repository,
    "binding.repository",
    140,
    REPOSITORY,
  );
  if (!Number.isSafeInteger(binding.pullRequestNumber) ||
      binding.pullRequestNumber < 1) {
    throw error;
  }
  exact(
    binding.subject,
    Object.hasOwn(binding.subject, "id")
      ? ["id", "repository", "number"]
      : ["repository", "number"],
    "binding.subject",
    error,
  );
  if (
    binding.subject.repository !== repository ||
    binding.subject.number !== binding.pullRequestNumber
  ) {
    throw error;
  }
  if (binding.subject.id !== undefined) {
    boundedText(binding.subject.id, "binding.subject.id", 512);
  }
  const headRefOid = boundedText(
    binding.headRefOid,
    "binding.headRefOid",
    64,
    GIT_OID,
  );
  let inputBinding;
  try {
    inputBinding = normalizePullRequestExecutionBinding(
      binding.inputBinding,
      error,
    );
  } catch {
    throw error;
  }
  if (
    inputBinding.schemaVersion !== 2 ||
    inputBinding.repository !== repository ||
    inputBinding.pullRequestNumber !== binding.pullRequestNumber ||
    inputBinding.headRefOid !== headRefOid ||
    inputBinding.eventId !== eventId
  ) {
    throw error;
  }
  return {
    repository,
    pullRequestNumber: binding.pullRequestNumber,
    headRefOid,
    inputBinding,
  };
}

function actionBody(value, name = "payload.action.body") {
  const body = boundedText(value, name, 8 * 1_024);
  if (!body.trim()) throw invalid(`${name} 无效`);
  return body;
}

function normalizeProposalAction(value, binding) {
  if (value?.type === "comment") {
    exact(value, ["type", "body"], "payload.action");
    return {
      proposalType: "comment",
      confirmationAction: {
        type: "pull_request_comment",
        body: actionBody(value.body),
        inputBinding: binding.inputBinding,
      },
    };
  }
  if (value?.type === "review") {
    exact(value, ["type", "verdict", "body"], "payload.action");
    const reviewEvent = REVIEW_EVENTS[value.verdict];
    if (reviewEvent === undefined) throw invalid("payload.action.verdict 无效");
    return {
      proposalType: "review",
      confirmationAction: {
        type: "pull_request_review",
        reviewEvent,
        body: actionBody(value.body),
        inputBinding: binding.inputBinding,
      },
    };
  }
  if (value?.type === "update_branch") {
    exact(value, ["type"], "payload.action");
    return {
      proposalType: "update_branch",
      confirmationAction: {
        type: "pull_request_update_branch",
        expectedHeadOid: binding.inputBinding.gitTarget.headRefOid,
        expectedBaseOid: binding.inputBinding.gitTarget.baseRefOid,
        inputBinding: binding.inputBinding,
      },
    };
  }
  if (value?.type === "push") {
    exact(value, ["type", "controlledCommitEvidence"], "payload.action");
    let evidence;
    try {
      evidence = normalizeControlledCommitEvidence(value.controlledCommitEvidence);
    } catch (cause) {
      throw invalid("payload.action.controlledCommitEvidence 无效", cause);
    }
    if (
      !samePullRequestExecutionBinding(
        evidence.executionSource.inputBinding,
        binding.inputBinding,
      )
    ) {
      throw invalid("受控 commit 证据与 PR 执行绑定不一致");
    }
    const target = binding.inputBinding.gitTarget;
    if (
      evidence.commit.parents[0] !== target.headRefOid ||
      (!isHeadRepairExecutionSource(evidence.executionSource) &&
        evidence.commit.parents[1] !== target.baseRefOid)
    ) {
      throw invalid("受控 commit 证据 parents 与 PR Git target 不一致");
    }
    return {
      proposalType: "push",
      confirmationAction: {
        type: "pull_request_push",
        expectedOldOid: target.headRefOid,
        remote: {
          repository: target.headRepository,
          refName: target.headRefName,
        },
        controlledCommitEvidence: evidence,
        inputBinding: binding.inputBinding,
      },
    };
  }
  if (value?.type === "merge") {
    exact(value, ["type", "method"], "payload.action");
    if (!MERGE_METHODS.has(value.method)) {
      throw invalid("payload.action.method 无效");
    }
    return {
      proposalType: "merge",
      confirmationAction: {
        type: "pull_request_merge",
        method: value.method,
        expectedHeadOid: binding.inputBinding.gitTarget.headRefOid,
        inputBinding: binding.inputBinding,
      },
    };
  }
  throw invalid("payload.action.type 无效");
}

function confirmationId(proposal, actionType) {
  const digest = createHash("sha256")
    .update(proposal.proposalId, "utf8")
    .update("\0", "utf8")
    .update(proposal.contentDigest, "utf8")
    .update("\0", "utf8")
    .update(actionType, "utf8")
    .digest("hex");
  return `confirmation-github-pr-${actionType.replaceAll("_", "-")}-${digest}`;
}

function displayFor(actionType, repository, number, payload, evidence) {
  const copyByAction = {
    comment: ["发布 PR 评论", "确认并发布评论"],
    review: ["发布 PR Review", "确认并发布 Review"],
    update_branch: ["更新 PR 分支", "确认并更新分支"],
    push: ["推送受控 commit", "确认并推送 commit"],
    merge: ["合并 PR", "确认并合并 PR"],
  };
  const [name, actionLabel] = copyByAction[actionType];
  return {
    title: `${repository} #${number} · ${name}`,
    summary: payload.summary,
    actionLabel,
    evidence,
  };
}

function queuePlan(value) {
  const {
    displayedPayloadDigest: _displayedPayloadDigest,
    approvalBindingDigest: _approvalBindingDigest,
    ...plan
  } = normalizeConfirmationPlan(value);
  return plan;
}

export function createPullRequestExternalActionConfirmationPlan(
  value,
  { actorAccountId } = {},
) {
  try {
    const proposal = normalizeStoredProposal(value);
    const binding = normalizeBinding(proposal);
    exact(
      proposal.payload,
      ["action", "summary", "reason", "evidence"],
      "payload",
      proposalInvalid("GitHub PR 外部动作提案 payload 无效"),
    );
    const payload = {
      ...proposal.payload,
      summary: boundedText(proposal.payload.summary, "payload.summary", 2_048),
      reason: boundedText(proposal.payload.reason, "payload.reason", 2_048),
      evidence: denseTextArray(proposal.payload.evidence, "payload.evidence"),
    };
    const action = normalizeProposalAction(payload.action, binding);
    const accountId = boundedText(
      actorAccountId,
      "actorAccountId",
      39,
      GITHUB_LOGIN,
    );
    if (
      binding.inputBinding.gitTarget.sourceAccountId.toLowerCase() !==
        accountId.toLowerCase()
    ) {
      throw invalid("GitHub 执行账号与 PR 观察账号不一致");
    }
    const actor = { provider: "github", accountId };
    const target = {
      provider: "github",
      resourceId: `${binding.repository}#${binding.pullRequestNumber}`,
      version: binding.headRefOid,
    };
    const display = displayFor(
      action.proposalType,
      binding.repository,
      binding.pullRequestNumber,
      payload,
      [payload.reason, ...payload.evidence],
    );
    return queuePlan({
      id: confirmationId(proposal, action.proposalType),
      kind: PULL_REQUEST_EXTERNAL_CONFIRMATION_KINDS[action.proposalType],
      requestedBy: proposal.requestedBy,
      actor,
      target,
      action: action.confirmationAction,
      display: {
        ...display,
        payload: { actor, target, action: action.confirmationAction },
      },
    });
  } catch (cause) {
    if (
      cause instanceof PullRequestExternalActionError ||
      cause?.code === "INVALID_GITHUB_PULL_REQUEST_ACTION_PROPOSAL"
    ) {
      throw cause;
    }
    throw invalid(undefined, cause);
  }
}

function parseTarget(value) {
  exact(value, ["provider", "resourceId", "version"], "target");
  if (value.provider !== "github") throw invalid("target.provider 无效");
  const separator = value.resourceId.lastIndexOf("#");
  if (separator < 1) throw invalid("target.resourceId 无效");
  const repository = boundedText(
    value.resourceId.slice(0, separator),
    "target.repository",
    140,
    REPOSITORY,
  );
  const numberText = value.resourceId.slice(separator + 1);
  if (!/^[1-9][0-9]*$/u.test(numberText)) {
    throw invalid("target.pullRequestNumber 无效");
  }
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) throw invalid("target.pullRequestNumber 无效");
  return {
    provider: "github",
    resourceId: `${repository}#${number}`,
    version: boundedText(value.version, "target.version", 64, GIT_OID),
    repository,
    number,
  };
}

function normalizeConfirmationAction(kind, value) {
  const expectedType = ACTION_BY_KIND[kind];
  if (expectedType === undefined || value?.type !== expectedType) {
    throw invalid("confirmation kind 与 action.type 不匹配");
  }
  let inputBinding;
  const normalizeBindingField = () => {
    try {
      inputBinding = normalizePullRequestExecutionBinding(
        value.inputBinding,
        invalid("action.inputBinding 无效"),
      );
    } catch (cause) {
      throw invalid("action.inputBinding 无效", cause);
    }
    if (inputBinding.schemaVersion !== 2) {
      throw invalid("外部动作必须绑定 v2 PullRequestExecutionBinding");
    }
  };
  if (expectedType === "pull_request_comment") {
    exact(value, ["type", "body", "inputBinding"], "action");
    normalizeBindingField();
    return { type: expectedType, body: actionBody(value.body, "action.body"), inputBinding };
  }
  if (expectedType === "pull_request_review") {
    exact(value, ["type", "reviewEvent", "body", "inputBinding", ...(Object.hasOwn(value, "publishedReviewReuse") ? ["publishedReviewReuse"] : [])], "action");
    normalizeBindingField();
    if (!Object.values(REVIEW_EVENTS).includes(value.reviewEvent)) {
      throw invalid("action.reviewEvent 无效");
    }
    return {
      type: expectedType,
      reviewEvent: value.reviewEvent,
      body: actionBody(value.body, "action.body"),
      inputBinding,
      ...(Object.hasOwn(value, "publishedReviewReuse") ? { publishedReviewReuse: normalizePublishedReviewReuse(value.publishedReviewReuse) } : {}),
    };
  }
  if (expectedType === "pull_request_update_branch") {
    exact(
      value,
      ["type", "expectedHeadOid", "expectedBaseOid", "inputBinding"],
      "action",
    );
    normalizeBindingField();
    const result = {
      type: expectedType,
      expectedHeadOid: boundedText(
        value.expectedHeadOid,
        "action.expectedHeadOid",
        64,
        GIT_OID,
      ),
      expectedBaseOid: boundedText(
        value.expectedBaseOid,
        "action.expectedBaseOid",
        64,
        GIT_OID,
      ),
      inputBinding,
    };
    if (
      result.expectedHeadOid !== inputBinding.gitTarget.headRefOid ||
      result.expectedBaseOid !== inputBinding.gitTarget.baseRefOid
    ) {
      throw invalid("update_branch 预期 OID 与 Git target 不一致");
    }
    return result;
  }
  if (expectedType === "pull_request_push") {
    exact(
      value,
      [
        "type",
        "expectedOldOid",
        "remote",
        "controlledCommitEvidence",
        "inputBinding",
      ],
      "action",
    );
    normalizeBindingField();
    exact(value.remote, ["repository", "refName"], "action.remote");
    let evidence;
    try {
      evidence = normalizeControlledCommitEvidence(value.controlledCommitEvidence);
    } catch (cause) {
      throw invalid("action.controlledCommitEvidence 无效", cause);
    }
    const target = inputBinding.gitTarget;
    const result = {
      type: expectedType,
      expectedOldOid: boundedText(
        value.expectedOldOid,
        "action.expectedOldOid",
        64,
        GIT_OID,
      ),
      remote: {
        repository: boundedText(
          value.remote.repository,
          "action.remote.repository",
          140,
          REPOSITORY,
        ),
        refName: boundedText(value.remote.refName, "action.remote.refName", 255),
      },
      controlledCommitEvidence: evidence,
      inputBinding,
    };
    if (
      result.expectedOldOid !== target.headRefOid ||
      result.remote.repository !== target.headRepository ||
      result.remote.refName !== target.headRefName ||
      !samePullRequestExecutionBinding(
        evidence.executionSource.inputBinding,
        inputBinding,
      ) ||
      evidence.commit.parents[0] !== target.headRefOid ||
      (!isHeadRepairExecutionSource(evidence.executionSource) &&
        evidence.commit.parents[1] !== target.baseRefOid)
    ) {
      throw invalid("push 未精确绑定受控 commit 与远程 Head");
    }
    return result;
  }
  exact(value, ["type", "method", "expectedHeadOid", "inputBinding"], "action");
  normalizeBindingField();
  if (!MERGE_METHODS.has(value.method)) throw invalid("action.method 无效");
  const expectedHeadOid = boundedText(
    value.expectedHeadOid,
    "action.expectedHeadOid",
    64,
    GIT_OID,
  );
  if (expectedHeadOid !== inputBinding.gitTarget.headRefOid) {
    throw invalid("merge expected Head 与 Git target 不一致");
  }
  return {
    type: expectedType,
    method: value.method,
    expectedHeadOid,
    inputBinding,
  };
}

export function normalizePullRequestExternalActionEnvelope(value) {
  try {
    exact(
      value,
      [
        "schemaVersion",
        "id",
        "idempotencyKey",
        "kind",
        "requestedBy",
        "actor",
        "target",
        "action",
        "displayedPayloadDigest",
        "approvalBindingDigest",
        "execution",
      ],
      "external action envelope",
    );
    if (value.schemaVersion !== 1) throw invalid("schemaVersion 无效");
    const id = boundedText(value.id, "id", 128, SAFE_ID);
    const kind = boundedText(value.kind, "kind", 128, SAFE_ID);
    exact(value.requestedBy, ["roleId", "workItemId"], "requestedBy");
    const requestedBy = {
      roleId: boundedText(value.requestedBy.roleId, "requestedBy.roleId", 128, SAFE_ID),
      workItemId: boundedText(value.requestedBy.workItemId, "requestedBy.workItemId", 256),
    };
    exact(value.actor, ["provider", "accountId"], "actor");
    if (value.actor.provider !== "github") throw invalid("actor.provider 无效");
    const actor = {
      provider: "github",
      accountId: boundedText(
        value.actor.accountId,
        "actor.accountId",
        39,
        GITHUB_LOGIN,
      ),
    };
    const parsedTarget = parseTarget(value.target);
    const target = {
      provider: "github",
      resourceId: parsedTarget.resourceId,
      version: parsedTarget.version,
    };
    const action = normalizeConfirmationAction(kind, value.action);
    if (
      action.inputBinding.repository !== parsedTarget.repository ||
      action.inputBinding.pullRequestNumber !== parsedTarget.number ||
      action.inputBinding.headRefOid !== target.version ||
      action.inputBinding.gitTarget.sourceAccountId.toLowerCase() !==
        actor.accountId.toLowerCase()
    ) {
      throw invalid("actor、target 与 v2 PR 执行绑定不一致");
    }
    const displayedPayloadDigest = boundedText(
      value.displayedPayloadDigest,
      "displayedPayloadDigest",
      64,
      SHA256,
    );
    const approvalBindingDigest = boundedText(
      value.approvalBindingDigest,
      "approvalBindingDigest",
      64,
      SHA256,
    );
    if (
      value.idempotencyKey !== `confirmation-${approvalBindingDigest}` ||
      approvalBindingDigest !== digestValue({
        id,
        kind,
        requestedBy,
        actor,
        target,
        action,
        displayedPayloadDigest,
      })
    ) {
      throw invalid("确认批准摘要绑定无效");
    }
    exact(value.execution, ["requestId", "attempt", "startedAt"], "execution");
    const execution = {
      requestId: boundedText(
        value.execution.requestId,
        "execution.requestId",
        128,
        REQUEST_ID,
      ),
      attempt: value.execution.attempt,
      startedAt: canonicalTimestamp(value.execution.startedAt, "execution.startedAt"),
    };
    if (!Number.isSafeInteger(execution.attempt) || execution.attempt < 1) {
      throw invalid("execution.attempt 无效");
    }
    return {
      schemaVersion: 1,
      id,
      idempotencyKey: value.idempotencyKey,
      kind,
      requestedBy,
      actor,
      target,
      action,
      displayedPayloadDigest,
      approvalBindingDigest,
      execution,
    };
  } catch (cause) {
    if (cause instanceof PullRequestExternalActionError) throw cause;
    throw invalid(undefined, cause);
  }
}

export function pullRequestExternalActionMarker(value) {
  const envelope = normalizePullRequestExternalActionEnvelope(value);
  const digest = digestValue({
    schemaVersion: 1,
    idempotencyKey: envelope.idempotencyKey,
    kind: envelope.kind,
    actor: envelope.actor,
    target: envelope.target,
    action: envelope.action,
    approvalBindingDigest: envelope.approvalBindingDigest,
  });
  return `<!-- ${MARKER_PREFIX}:${digest} -->`;
}

export function samePullRequestExternalControlledEvidence(left, right) {
  return sameControlledCommitEvidence(left, right);
}
