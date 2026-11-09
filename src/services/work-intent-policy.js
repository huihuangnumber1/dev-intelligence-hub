import { createHash } from "node:crypto";

import { normalizeDeliveryEvidenceTarget } from "../domain/delivery-evidence-contract.js";
import {
  normalizeStoredWorkflowEvent,
  normalizeWorkflowEvent,
} from "../domain/workflow-events.js";
import { normalizeWorkIntent } from "../domain/work-intent.js";
import { normalizeCodeExecutionSource } from "../domain/code-execution-source.js";
import { normalizeControlledCommitEvidence } from "../domain/controlled-commit-evidence.js";
import {
  normalizePullRequestExecutionBinding,
  pullRequestExecutionBindingMatchesEvent,
  samePullRequestExecutionBinding,
} from "../domain/pull-request-execution-binding.js";

const SAFE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const INVALID_CONTROL = /[\u0000-\u001f\u007f]/;
const CAPABILITIES = new Set([
  "coordination",
  "requirements",
  "pr-review",
  "development",
  "testing",
]);
const ACTIVE_PR_EVENTS = new Set([
  "pull_request.observed",
  "pull_request.created",
  "pull_request.updated",
  "pull_request.classified",
  "pull_request.status",
]);
const REVIEWABLE_PR_EVENTS = new Set([
  ...ACTIVE_PR_EVENTS,
  "pull_request.owner_requested",
]);
const CODE_OPERATIONS = Object.freeze(["inspect", "modify", "verify"]);

export class WorkIntentPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkIntentPolicyError";
    this.code = code;
    this.statusCode = code === "WORK_INTENT_CONTEXT_INVALID" ? 400 : 409;
  }
}

function contextError(message = "员工工作上下文无效") {
  throw new WorkIntentPolicyError("WORK_INTENT_CONTEXT_INVALID", message);
}

function denied(message = "岗位无权提出该工作意图") {
  throw new WorkIntentPolicyError("WORK_INTENT_POLICY_DENIED", message);
}

function plainEntries(value, onError = contextError) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    onError();
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      onError();
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exact(value, keys, onError = contextError) {
  const entries = plainEntries(value, onError);
  const actual = entries.map(([key]) => key);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key))
  ) {
    onError();
  }
  return new Map(entries);
}

function safeId(value, name, onError = contextError) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    onError(`${name} 无效`);
  }
  return value;
}

function boundedId(value, name) {
  if (
    typeof value !== "string" ||
    !value ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    contextError(`${name} 无效`);
  }
  return value;
}

function strictArray(value, maximum, onError) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    onError();
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, `${index}`);
    if (!descriptor?.enumerable || !("value" in descriptor)) onError();
  }
  return value;
}

function normalizeRoleList(value, name) {
  const roles = strictArray(value, 100, () => contextError(`${name} 无效`)).map(
    (roleId) => safeId(roleId, name),
  );
  if (new Set(roles).size !== roles.length) contextError(`${name} 重复`);
  return new Set(roles);
}

function normalizeCapabilityRoles(value) {
  const entries = plainEntries(value);
  const result = new Map();
  for (const [capability, roleId] of entries) {
    if (!CAPABILITIES.has(capability) || result.has(capability)) {
      contextError("capabilityRoles 无效");
    }
    result.set(capability, safeId(roleId, "capabilityRoles.roleId"));
  }
  return result;
}

function normalizeWorkspaces(value) {
  const entries = plainEntries(value);
  const result = new Map();
  for (const [repository, workspaceId] of entries) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      result.has(repository)
    ) {
      contextError("workspaceByRepository.repository 无效");
    }
    result.set(repository, safeId(workspaceId, "workspaceId"));
  }
  return result;
}

function normalizeCodeOperations(value, codeRoles) {
  const entries = plainEntries(value);
  const result = new Map();
  for (const [roleId, rawOperations] of entries) {
    const normalizedRoleId = safeId(roleId, "codeOperationsByRole.roleId");
    if (!codeRoles.has(normalizedRoleId) || result.has(normalizedRoleId)) {
      contextError("codeOperationsByRole.roleId 无效");
    }
    const operations = strictArray(rawOperations, CODE_OPERATIONS.length, () =>
      contextError("codeOperationsByRole.operations 无效"),
    );
    if (
      operations.length < 1 ||
      operations.some((operation) => !CODE_OPERATIONS.includes(operation)) ||
      new Set(operations).size !== operations.length
    ) {
      contextError("codeOperationsByRole.operations 无效");
    }
    result.set(normalizedRoleId, new Set(operations));
  }
  return result;
}

function cloneAndFreeze(value) {
  const cloned = structuredClone(value);
  const freeze = (entry) => {
    if (entry !== null && typeof entry === "object") {
      for (const child of Object.values(entry)) freeze(child);
      Object.freeze(entry);
    }
    return entry;
  };
  return freeze(cloned);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function normalizeContext(value) {
  const optionalKeys = [
    "inputBinding",
    "executionSource",
    "controlledCommitEvidence",
    "evidenceTarget",
    "internalReview",
  ].filter((key) => Object.hasOwn(value ?? {}, key));
  const entries = exact(value, [
    "assignmentId",
    "workItemId",
    "roleId",
    "event",
    ...optionalKeys,
  ]);
  const suppliedEvent = entries.get("event");
  const event =
    suppliedEvent && typeof suppliedEvent === "object" && Object.hasOwn(suppliedEvent, "eventId")
      ? normalizeStoredWorkflowEvent(suppliedEvent)
      : normalizeWorkflowEvent(suppliedEvent);
  const context = {
    assignmentId: boundedId(entries.get("assignmentId"), "assignmentId"),
    workItemId: boundedId(entries.get("workItemId"), "workItemId"),
    roleId: safeId(entries.get("roleId"), "roleId"),
    event,
  };
  if (entries.has("internalReview")) {
    if (entries.get("internalReview") !== true) contextError("internalReview 无效");
    context.internalReview = true;
  }
  if (entries.has("evidenceTarget")) {
    try {
      context.evidenceTarget = normalizeDeliveryEvidenceTarget(
        entries.get("evidenceTarget"),
      );
    } catch {
      contextError("evidenceTarget 无效");
    }
  }
  if (entries.has("inputBinding")) {
    if (entries.get("inputBinding") === null) {
      context.inputBinding = null;
    } else {
      try {
        context.inputBinding = normalizePullRequestExecutionBinding(
          entries.get("inputBinding"),
        );
      } catch {
        contextError("inputBinding 无效");
      }
    }
  }
  if (context.inputBinding !== undefined && context.inputBinding !== null) {
    const binding = context.inputBinding;
    if (
      !context.event.eventType.startsWith("pull_request.") ||
      !pullRequestExecutionBindingMatchesEvent(binding, context.event)
    ) {
      contextError("inputBinding 与工作事件不匹配");
    }
  }
  if (entries.has("executionSource")) {
    try {
      context.executionSource = normalizeCodeExecutionSource(
        entries.get("executionSource"),
      );
    } catch {
      contextError("executionSource 无效");
    }
    if (
      context.inputBinding === undefined ||
      context.inputBinding === null ||
      !samePullRequestExecutionBinding(
        context.executionSource.inputBinding,
        context.inputBinding,
      )
    ) {
      contextError("executionSource 与 PR 输入绑定不匹配");
    }
  }
  if (entries.has("controlledCommitEvidence")) {
    try {
      context.controlledCommitEvidence = normalizeControlledCommitEvidence(
        entries.get("controlledCommitEvidence"),
      );
    } catch {
      contextError("controlledCommitEvidence 无效");
    }
    if (
      context.inputBinding === undefined ||
      context.inputBinding === null ||
      context.inputBinding.schemaVersion !== 2 ||
      !samePullRequestExecutionBinding(
        context.controlledCommitEvidence.executionSource.inputBinding,
        context.inputBinding,
      )
    ) {
      contextError("controlledCommitEvidence 与 PR 输入绑定不匹配");
    }
  }
  return context;
}

function proposalInputBinding(context) {
  if (!Object.hasOwn(context, "inputBinding")) {
    denied("代码或 Review 提案缺少可信输入绑定");
  }
  if (
    context.event.eventType.startsWith("pull_request.") &&
    context.inputBinding === null
  ) {
    denied("PR 提案缺少可信输入绑定");
  }
  if (
    !context.event.eventType.startsWith("pull_request.") &&
    context.inputBinding !== null
  ) {
    contextError("非 PR 工作不能携带 PR 输入绑定");
  }
  return context.inputBinding === null
    ? null
    : structuredClone(context.inputBinding);
}

function proposalAuthorityBinding(context, intent) {
  const target = context.evidenceTarget;
  if (
    target !== undefined &&
    (target.taskId !== context.workItemId || target.roleId !== context.roleId)
  ) {
    contextError("evidenceTarget 与工作上下文不匹配");
  }
  if (
    target !== undefined &&
    intent.deliverableId !== undefined &&
    target.deliverables[0].deliverableId !== intent.deliverableId
  ) {
    contextError("evidenceTarget 与 deliverableId 不匹配");
  }
  return {
    ...(target === undefined
      ? {}
      : { evidenceTarget: structuredClone(target) }),
    ...(intent.dispatchIntentId === undefined
      ? {}
      : { dispatchIntentId: intent.dispatchIntentId }),
  };
}

function baseBound(context, version, kind, binding, payload) {
  const value = {
    policyVersion: version,
    kind,
    requestedBy: {
      roleId: context.roleId,
      workItemId: context.workItemId,
    },
    source: {
      assignmentId: context.assignmentId,
      eventId: context.event.eventId,
    },
    binding,
    payload,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(stable(value)), "utf8")
    .digest("hex");
  return cloneAndFreeze({ intentId: `work-intent-${digest}`, ...value });
}

function eventBinding(event) {
  return { eventId: event.eventId, subject: structuredClone(event.subject) };
}

export function createWorkIntentPolicy({
  version = 1,
  capabilityRoles = {},
  githubReviewRoles = [],
  codeActionRoles = [],
  configurationChangeRoles = [],
  workspaceByRepository = {},
  codeOperationsByRole = {},
} = {}) {
  if (!Number.isSafeInteger(version) || version < 1) {
    contextError("policy version 无效");
  }
  const trustedCapabilities = normalizeCapabilityRoles(capabilityRoles);
  const trustedGithubRoles = normalizeRoleList(
    githubReviewRoles,
    "githubReviewRoles",
  );
  const trustedCodeRoles = normalizeRoleList(codeActionRoles, "codeActionRoles");
  const trustedConfigurationChangeRoles = normalizeRoleList(
    configurationChangeRoles,
    "configurationChangeRoles",
  );
  const trustedWorkspaces = normalizeWorkspaces(workspaceByRepository);
  const trustedCodeOperations = normalizeCodeOperations(
    codeOperationsByRole,
    trustedCodeRoles,
  );

  function bind({ context: contextValue, intent: intentValue } = {}) {
    const context = normalizeContext(contextValue);
    const intent = normalizeWorkIntent(intentValue);
    const internalReview = context.internalReview === true ||
      context.event.eventType === "pull_request.internal_review_requested" ||
      (context.roleId === trustedCapabilities.get("pr-review") &&
       context.event.eventType === "pull_request.owner_requested" &&
       context.event.payload?.workType === "development");
    if (internalReview && ["propose_github_review", "propose_github_pull_request_action"].includes(intent.type)) {
      denied("内部复审结果应在本地交付或退回研发");
    }
    if (
      context.executionSource !== undefined &&
      intent.type !== "propose_code_action"
    ) {
      denied("Conflict preparation 只能用于代码工作提案");
    }
    if (
      context.controlledCommitEvidence !== undefined &&
      !(
        intent.type === "propose_github_pull_request_action" &&
        intent.action.type === "push"
      )
    ) {
      denied("受控 commit 证据只能用于 push 外部动作提案");
    }
    const commonPayload = { summary: intent.summary, reason: intent.reason };

    if (["orchestrate", "submit_delivery"].includes(intent.type)) {
      denied("编排和岗位交付意图必须由共享任务图的可信服务处理");
    }

    if (intent.type === "ask_user") {
      return baseBound(
        context,
        version,
        "attention_request",
        eventBinding(context.event),
        {
          question: intent.question,
          choices: intent.choices,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "wait_condition") {
      return baseBound(
        context,
        version,
        "wait_condition",
        eventBinding(context.event),
        {
          condition: intent.condition,
          checkAfterSeconds: intent.checkAfterSeconds,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "propose_github_review") {
      if (!trustedGithubRoles.has(context.roleId)) denied();
      if (!REVIEWABLE_PR_EVENTS.has(context.event.eventType)) {
        denied("只有活动 PR 事件可以提出 Review");
      }
      if (
        context.event.eventType === "pull_request.owner_requested" &&
        context.event.payload?.state !== "open"
      ) {
        denied("所有者指定的 PR 必须处于 OPEN 状态");
      }
      const headRefOid = context.event.payload?.headRefOid;
      if (typeof headRefOid !== "string" || !headRefOid) {
        denied("PR 事件缺少可信 Head");
      }
      return baseBound(
        context,
        version,
        "github_review_proposal",
        {
          ...eventBinding(context.event),
          repository: context.event.subject.repository,
          pullRequestNumber: context.event.subject.number,
          headRefOid,
          inputBinding: proposalInputBinding(context),
          ...proposalAuthorityBinding(context, intent),
        },
        {
          verdict: intent.verdict,
          body: intent.body,
          ...(intent.publicationReuse === undefined ? {} : { publicationReuse: intent.publicationReuse }),
          evidence: intent.evidence,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "propose_github_pull_request_action") {
      if (!trustedGithubRoles.has(context.roleId)) denied();
      if (!ACTIVE_PR_EVENTS.has(context.event.eventType)) {
        denied("只有活动 PR 事件可以提出外部动作");
      }
      const headRefOid = context.event.payload?.headRefOid;
      if (typeof headRefOid !== "string" || !headRefOid) {
        denied("PR 事件缺少可信 Head");
      }
      const inputBinding = proposalInputBinding(context);
      if (inputBinding === null || inputBinding.schemaVersion !== 2) {
        denied("PR 外部动作必须绑定 v2 Git target");
      }
      let action = structuredClone(intent.action);
      if (intent.action.type === "push") {
        const controlledCommitEvidence = context.controlledCommitEvidence;
        if (
          controlledCommitEvidence === undefined ||
          controlledCommitEvidence.evidenceId !==
            intent.action.controlledCommitEvidenceId
        ) {
          denied("push 缺少匹配的受控 commit 证据");
        }
        action = {
          type: "push",
          controlledCommitEvidence: structuredClone(controlledCommitEvidence),
        };
      }
      return baseBound(
        context,
        version,
        "github_pull_request_action_proposal",
        {
          ...eventBinding(context.event),
          repository: context.event.subject.repository,
          pullRequestNumber: context.event.subject.number,
          headRefOid,
          inputBinding,
          ...proposalAuthorityBinding(context, intent),
        },
        {
          action,
          evidence: intent.evidence,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "propose_code_action") {
      if (!trustedCodeRoles.has(context.roleId)) denied();
      const allowedOperations = trustedCodeOperations.get(context.roleId);
      if (allowedOperations && !allowedOperations.has(intent.operation)) {
        denied("岗位无权提出该代码操作");
      }
      const repository = context.event.subject.repository;
      const workspaceId = trustedWorkspaces.get(repository);
      if (!workspaceId) denied("事件仓库没有受信工作区映射");
      const inputBinding = proposalInputBinding(context);
      if (inputBinding !== null && inputBinding.schemaVersion !== 2) {
        denied("旧版 PR 输入绑定只能恢复查看，不能创建新的代码工作提案");
      }
      if (context.executionSource !== undefined && intent.operation !== "modify") {
        denied("Conflict preparation 只能创建 modify 代码工作提案");
      }
      return baseBound(
        context,
        version,
        "code_action_proposal",
        {
          ...eventBinding(context.event),
          repository,
          workspaceId,
          inputBinding,
          ...(context.executionSource === undefined
            ? {}
            : { executionSource: structuredClone(context.executionSource) }),
          ...proposalAuthorityBinding(context, intent),
        },
        {
          operation: intent.operation,
          objective: intent.objective,
          acceptanceCriteria: intent.acceptanceCriteria,
          evidence: intent.evidence,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "propose_configuration_change") {
      if (!trustedConfigurationChangeRoles.has(context.roleId)) denied();
      return baseBound(
        context,
        version,
        "configuration_change_proposal",
        {
          ...eventBinding(context.event),
          ...proposalAuthorityBinding(context, intent),
        },
        {
          changes: intent.changes,
          evidence: intent.evidence,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "handoff") {
      const targetRoleId = trustedCapabilities.get(intent.capability);
      if (!targetRoleId) denied("能力没有受信岗位映射");
      return baseBound(
        context,
        version,
        "handoff",
        { ...eventBinding(context.event), targetRoleId },
        {
          capability: intent.capability,
          brief: intent.brief,
          evidence: intent.evidence,
          ...commonPayload,
        },
      );
    }
    if (intent.type === "complete") {
      return baseBound(
        context,
        version,
        "complete",
        eventBinding(context.event),
        {
          outcome: intent.outcome,
          evidence: intent.evidence,
          ...commonPayload,
        },
      );
    }
    denied();
  }

  return Object.freeze({ bind });
}
