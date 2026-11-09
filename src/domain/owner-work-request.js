import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeWorkflowEvent } from "./workflow-events.js";
import { normalizeInternalReviewMetadata } from "./internal-repair-review.js";

export const OWNER_WORK_REQUEST_EVENT_TYPE = "owner_request.created";
export const OWNER_WORK_REQUEST_DEFAULT_RULE_ID =
  "system-owner-request-to-orchestrator";
export const OWNER_PULL_REQUEST_RULE_ID =
  "system-owner-request-to-pr-engineer";
export const OWNER_PULL_REQUEST_DEVELOPMENT_RULE_ID =
  "system-owner-pr-development-to-developer";
export const OWNER_PULL_REQUEST_TESTING_RULE_ID =
  "system-owner-pr-testing-to-tester";
export const OWNER_PULL_REQUEST_ORCHESTRATION_RULE_ID =
  "system-owner-pr-coordination-to-orchestrator";
const OWNER_CAPABILITY_ROUTES = Object.freeze([
  Object.freeze({
    ruleId: "system-owner-review-to-pr-engineer",
    workType: "pull_request",
    roleId: "pr-engineer",
  }),
  Object.freeze({
    ruleId: "system-owner-development-to-developer",
    workType: "development",
    roleId: "developer",
  }),
  Object.freeze({
    ruleId: "system-owner-testing-to-tester",
    workType: "testing",
    roleId: "tester",
  }),
  Object.freeze({
    ruleId: "system-owner-requirements-to-analyst",
    workType: "requirements",
    roleId: "requirements-analyst",
  }),
]);
const OWNER_PULL_REQUEST_CAPABILITY_ROUTES = Object.freeze([
  Object.freeze({
    ruleId: OWNER_PULL_REQUEST_ORCHESTRATION_RULE_ID,
    workType: "general",
    roleId: "orchestrator",
  }),
  Object.freeze({
    ruleId: OWNER_PULL_REQUEST_RULE_ID,
    workType: "pull_request",
    roleId: "pr-engineer",
  }),
  Object.freeze({
    ruleId: OWNER_PULL_REQUEST_DEVELOPMENT_RULE_ID,
    workType: "development",
    roleId: "developer",
  }),
  Object.freeze({
    ruleId: OWNER_PULL_REQUEST_TESTING_RULE_ID,
    workType: "testing",
    roleId: "tester",
  }),
]);
export const OWNER_WORK_REQUEST_TYPES = Object.freeze([
  "general",
  "requirements",
  "development",
  "testing",
  "pull_request",
]);
export const OWNER_WORK_REQUEST_PRIORITIES = Object.freeze([
  "normal",
  "high",
  "urgent",
]);

const REQUEST_KEYS = Object.freeze([
  "schemaVersion",
  "requestId",
  "workType",
  "priority",
  "title",
  "description",
  "acceptanceCriteria",
]);
const PULL_REQUEST_KEYS = Object.freeze([...REQUEST_KEYS, "pullRequest"]);
const INTERNAL_REVIEW_REQUEST_KEYS = Object.freeze([...PULL_REQUEST_KEYS, "internalReview"]);
const INTERNAL_REVIEW_RULE_ID = "system-internal-repair-review-to-pr-engineer";
const ISSUE_KEYS = Object.freeze([...REQUEST_KEYS, "issue"]);
const PERSON_PULL_REQUEST_KEYS = Object.freeze([
  ...REQUEST_KEYS,
  "pullRequest",
  "responsiblePerson",
]);
const ORCHESTRATED_PULL_REQUEST_KEYS = Object.freeze([
  ...PULL_REQUEST_KEYS,
  "predecessorRequestId",
  "triage",
]);
const PULL_REQUEST_TARGET_KEYS = Object.freeze(["repository", "number"]);
const RESPONSIBLE_PERSON_KEYS = Object.freeze(["login", "product"]);
const TRIAGE_KEYS = Object.freeze([
  "nextAction",
  "suggestedCapability",
  "expectedHeadRefOid",
]);
const REQUEST_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const INVALID_CONTROL = /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_TITLE_BYTES = 256;
const MAX_DESCRIPTION_BYTES = 12 * 1024;
const MAX_CRITERIA = 20;
const MAX_CRITERION_BYTES = 1_000;
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})$/;
const SAFE_GITHUB_LOGIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SAFE_PRODUCT = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_CAPABILITY = /^(?:development|pr-review)$/;
const GIT_OID = /^[a-f0-9]{40}$/;

export class OwnerWorkRequestError extends Error {
  constructor(code, message, statusCode = 400, options = {}) {
    super(message, options);
    this.name = "OwnerWorkRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalid(message = "所有者工作请求无效") {
  return new OwnerWorkRequestError(
    "OWNER_WORK_REQUEST_INVALID",
    message,
  );
}

function dataKeys(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${label}必须是普通对象`);
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      throw invalid(`${label}包含不安全字段`);
    }
  }
  return keys;
}

function exactKeys(value, expected, label) {
  const keys = dataKeys(value, label);
  if (
    keys.length !== expected.length ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw invalid(`${label}字段无效`);
  }
}

function boundedText(value, label, maximumBytes) {
  if (typeof value !== "string" || INVALID_CONTROL.test(value)) {
    throw invalid(`${label}无效`);
  }
  const normalized = value.trim();
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (!normalized || bytes > maximumBytes) {
    throw invalid(`${label}无效`);
  }
  return normalized;
}

function denseArray(value, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_CRITERIA ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid(`${label}无效`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw invalid(`${label}无效`);
    }
  }
  return value;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function ownerWorkRequestDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function deterministicRequestId(seed) {
  const digest = createHash("sha256").update(seed, "utf8").digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

export function createPrTriageWorkRequest({
  requestKey,
  targetRoleId,
  repository,
  number,
  nextAction,
  expectedHeadRefOid,
}) {
  if (
    typeof requestKey !== "string" ||
    requestKey.length < 1 ||
    requestKey.length > 256 ||
    !["pr-engineer", "developer"].includes(targetRoleId) ||
    typeof repository !== "string" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof nextAction !== "string" ||
    nextAction.length < 1 ||
    nextAction.length > 128 ||
    typeof expectedHeadRefOid !== "string" ||
    !GIT_OID.test(expectedHeadRefOid)
  ) {
    throw invalid("PR 初判分流请求无效");
  }
  return normalizeOwnerWorkRequest({
    schemaVersion: 5,
    requestId: deterministicRequestId(`pr-triage-orchestrated:${requestKey}`),
    predecessorRequestId: deterministicRequestId(`pr-triage:${requestKey}`),
    workType: "general",
    priority: ["fix_ci", "resolve_conflict", "address_review"].includes(nextAction)
      ? "urgent"
      : "high",
    title: `PR 初判分流：${repository} #${number}`,
    description: [
      `PR 推进员工已完成 ${repository} #${number} 的基础初判。`,
      `下一动作：${nextAction}。`,
      `建议能力：${targetRoleId === "developer" ? "development" : "pr-review"}。`,
      "请由主控调度员核对优先级、创建岗位子任务，并负责验收后续交付。",
    ].join("\n"),
    acceptanceCriteria: [
      "核对 PR 最新 Head、状态与检查结果",
      targetRoleId === "developer"
        ? "完成必要的代码修复与验证，并提交可追踪交付"
        : "完成有证据的代码 Review，并明确下一推进岗位",
    ],
    pullRequest: { repository, number },
    triage: {
      nextAction,
      suggestedCapability:
        targetRoleId === "developer" ? "development" : "pr-review",
      expectedHeadRefOid,
    },
  });
}

export function normalizeOwnerWorkRequest(value) {
  const version = value?.schemaVersion;
  const hasReviewPurpose = value !== null && typeof value === "object" && Object.hasOwn(value, "reviewPurpose");
  const requestKeys = version === 7
      ? INTERNAL_REVIEW_REQUEST_KEYS
      : version === 5
      ? ORCHESTRATED_PULL_REQUEST_KEYS
      : version === 6
      ? ISSUE_KEYS
      : version === 2
      ? PULL_REQUEST_KEYS
      : [3, 4].includes(version)
        ? PERSON_PULL_REQUEST_KEYS
        : REQUEST_KEYS;
  exactKeys(value, [...requestKeys, ...(hasReviewPurpose ? ["reviewPurpose"] : [])], "所有者工作请求");
  if (hasReviewPurpose &&
      (![2, 4, 5].includes(version) || !["standard_current_pr_code_review/v1", "independent_review/v1"].includes(value.reviewPurpose))) throw invalid("Review purpose 无效");
  if (
    ![1, 2, 3, 4, 5, 6, 7].includes(version) ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID.test(value.requestId) ||
    !OWNER_WORK_REQUEST_TYPES.includes(value.workType) ||
    !OWNER_WORK_REQUEST_PRIORITIES.includes(value.priority)
  ) {
    throw invalid();
  }
  if (
    version === 2 && !["pull_request", "development", "testing"].includes(value.workType)
  ) {
    throw invalid("PR Review、开发或测试分流必须提供结构化 PR 目标");
  }
  if (version === 5 && value.workType !== "general") {
    throw invalid("主控 PR 请求必须使用 general 工作类型");
  }
  if (version === 6 && value.workType === "pull_request") {
    throw invalid("Issue 不能使用 PR Review 工作类型");
  }
  if (version === 7 && value.workType !== "pull_request") throw invalid("内部复审必须使用 PR 工作类型");
  if (
    version === 5 &&
    (
      typeof value.predecessorRequestId !== "string" ||
      !REQUEST_ID.test(value.predecessorRequestId) ||
      value.predecessorRequestId === value.requestId
    )
  ) {
    throw invalid("主控 PR 请求的前任幂等标识无效");
  }
  if (version === 3 && value.workType !== "testing") {
    throw invalid("具体负责人只能绑定测试交接请求");
  }
  if (
    version === 4 &&
    !["pull_request", "development"].includes(value.workType)
  ) {
    throw invalid("具体负责人只能绑定 Review 或开发交接请求");
  }
  const acceptanceCriteria = denseArray(
    value.acceptanceCriteria,
    "acceptanceCriteria",
  ).map((criterion) =>
    boundedText(criterion, "acceptanceCriteria 条目", MAX_CRITERION_BYTES)
  );
  if (new Set(acceptanceCriteria).size !== acceptanceCriteria.length) {
    throw invalid("acceptanceCriteria 不能重复");
  }
  const normalized = {
    schemaVersion: version,
    requestId: value.requestId,
    workType: value.workType,
    priority: value.priority,
    title: boundedText(value.title, "title", MAX_TITLE_BYTES),
    description: boundedText(
      value.description,
      "description",
      MAX_DESCRIPTION_BYTES,
    ),
    acceptanceCriteria,
    ...(Object.hasOwn(value, "reviewPurpose") ? { reviewPurpose: value.reviewPurpose } : {}),
  };
  if ([2, 3, 4, 5, 7].includes(version)) {
    exactKeys(value.pullRequest, PULL_REQUEST_TARGET_KEYS, "pullRequest");
    const repository = value.pullRequest.repository;
    const match = typeof repository === "string"
      ? repository.match(REPOSITORY)
      : null;
    if (
      match === null ||
      match[1].includes("--") ||
      match[2].includes("..") ||
      match[2].startsWith(".") ||
      match[2].endsWith(".") ||
      !Number.isSafeInteger(value.pullRequest.number) ||
      value.pullRequest.number < 1
    ) {
      throw invalid("pullRequest 无效");
    }
    normalized.pullRequest = {
      repository,
      number: value.pullRequest.number,
    };
  }
  if (version === 7) normalized.internalReview = normalizeInternalReviewMetadata(value.internalReview);
  if (version === 6) {
    exactKeys(value.issue, PULL_REQUEST_TARGET_KEYS, "issue");
    const repository = value.issue.repository;
    const match = typeof repository === "string"
      ? repository.match(REPOSITORY)
      : null;
    if (
      !match ||
      match[1].includes("--") ||
      match[2].includes("..") ||
      match[2].startsWith(".") ||
      match[2].endsWith(".") ||
      !Number.isSafeInteger(value.issue.number) ||
      value.issue.number < 1
    ) {
      throw invalid("issue 无效");
    }
    normalized.issue = { repository, number: value.issue.number };
  }
  if (version === 5) {
    exactKeys(value.triage, TRIAGE_KEYS, "triage");
    const nextAction = boundedText(
      value.triage.nextAction,
      "triage.nextAction",
      128,
    );
    const suggestedCapability = boundedText(
      value.triage.suggestedCapability,
      "triage.suggestedCapability",
      64,
    );
    const expectedHeadRefOid = value.triage.expectedHeadRefOid;
    if (
      !SAFE_CAPABILITY.test(suggestedCapability) ||
      typeof expectedHeadRefOid !== "string" ||
      !GIT_OID.test(expectedHeadRefOid)
    ) {
      throw invalid("triage 无效");
    }
    normalized.predecessorRequestId = value.predecessorRequestId;
    normalized.triage = {
      nextAction,
      suggestedCapability,
      expectedHeadRefOid,
    };
  }
  if ([3, 4].includes(version)) {
    exactKeys(
      value.responsiblePerson,
      RESPONSIBLE_PERSON_KEYS,
      "responsiblePerson",
    );
    const login = boundedText(
      value.responsiblePerson.login,
      "responsiblePerson.login",
      40,
    );
    const product = boundedText(
      value.responsiblePerson.product,
      "responsiblePerson.product",
      128,
    );
    if (!SAFE_GITHUB_LOGIN.test(login) || !SAFE_PRODUCT.test(product)) {
      throw invalid("responsiblePerson 无效");
    }
    normalized.responsiblePerson = { login, product };
  }
  return deepFreeze(normalized);
}

export function normalizeStoredOwnerWorkRequest(value) {
  try {
    return normalizeOwnerWorkRequest(value);
  } catch (cause) {
    if (value?.schemaVersion !== 5) throw cause;
    try {
      exactKeys(value, PULL_REQUEST_KEYS, "历史主控 PR 请求");
      if (value.workType !== "general") throw cause;
      const validated = normalizeOwnerWorkRequest({
        ...value,
        schemaVersion: 2,
        workType: "pull_request",
      });
      return deepFreeze({
        ...validated,
        schemaVersion: 5,
        workType: "general",
      });
    } catch {
      throw cause;
    }
  }
}

export function createOwnerWorkRequestEvent(requestValue, occurredAt) {
  const request = normalizeOwnerWorkRequest(requestValue);
  if (request.schemaVersion !== 1) {
    throw invalid("PR 推进请求必须先解析可信 Git 目标");
  }
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: OWNER_WORK_REQUEST_EVENT_TYPE,
    occurredAt,
    source: {
      provider: "local-owner",
      scopeId: "owner-command-center",
    },
    subject: {
      id: `owner-request:${request.requestId}`,
      requestId: request.requestId,
    },
    payload: {
      title: request.title,
      description: request.description,
      workType: request.workType,
      priority: request.priority,
      acceptanceCriteria: [...request.acceptanceCriteria],
    },
  });
}

export function createOwnerPullRequestEvent(
  requestValue,
  resolvedValue,
  occurredAt,
) {
  const request = normalizeOwnerWorkRequest(requestValue);
  if (![2, 3, 4, 5, 7].includes(request.schemaVersion)) {
    throw invalid("PR 推进请求无效");
  }
  exactKeys(
    resolvedValue,
    ["repository", "number", "title", "state", "gitTarget"],
    "PR 解析结果",
  );
  const resolved = resolvedValue;
  if (
    resolved.repository !== request.pullRequest.repository ||
    resolved.number !== request.pullRequest.number ||
    typeof resolved.title !== "string" ||
    resolved.title.trim() === "" ||
    resolved.state !== "open" ||
    resolved.gitTarget === null ||
    typeof resolved.gitTarget !== "object" ||
    (request.schemaVersion === 5 &&
      resolved.gitTarget.headRefOid !== request.triage.expectedHeadRefOid) ||
    (request.schemaVersion === 7 && resolved.gitTarget.headRefOid !== request.internalReview.headRefOid)
  ) {
    throw invalid("PR 解析结果与请求不一致");
  }
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: request.schemaVersion === 7 ? "pull_request.internal_review_requested" : "pull_request.owner_requested",
    occurredAt,
    source: {
      provider: request.schemaVersion === 7 ? "internal-review-repair" : "local-owner",
      scopeId: `${request.schemaVersion === 7 ? "internal-review" : "owner-request"}:${request.requestId}`,
    },
    subject: {
      id: `github:pr:${request.pullRequest.repository}#${request.pullRequest.number}`,
      repository: request.pullRequest.repository,
      number: request.pullRequest.number,
    },
    payload: {
      title: resolved.title.trim(),
      description: request.description,
      workType: request.workType,
      priority: request.priority,
      acceptanceCriteria: [...request.acceptanceCriteria],
      headRefOid: resolved.gitTarget.headRefOid,
      state: resolved.state,
      gitTargetAvailable: true,
      gitTarget: structuredClone(resolved.gitTarget),
      ...(Object.hasOwn(request, "reviewPurpose") ? { reviewPurpose: request.reviewPurpose } : {}),
      ...(request.schemaVersion === 7 ? { internalReview: structuredClone(request.internalReview) } : {}),
      ...(request.schemaVersion === 5
        ? {
            nextAction: request.triage.nextAction,
            suggestedCapability: request.triage.suggestedCapability,
            expectedHeadRefOid: request.triage.expectedHeadRefOid,
          }
        : {}),
      ...([3, 4].includes(request.schemaVersion)
        ? { responsiblePerson: structuredClone(request.responsiblePerson) }
        : {}),
    },
  });
}

export function createOwnerIssueEvent(requestValue, occurredAt) {
  const request = normalizeOwnerWorkRequest(requestValue);
  if (request.schemaVersion !== 6) {
    throw invalid("Issue 推进请求无效");
  }
  return normalizeWorkflowEvent({
    schemaVersion: 1,
    eventType: "issue.owner_requested",
    occurredAt,
    source: {
      provider: "local-owner",
      scopeId: `owner-request:${request.requestId}`,
    },
    subject: {
      id: `github:issue:${request.issue.repository}#${request.issue.number}`,
      repository: request.issue.repository,
      number: request.issue.number,
    },
    payload: {
      title: request.title,
      description: request.description,
      workType: request.workType,
      priority: request.priority,
      acceptanceCriteria: [...request.acceptanceCriteria],
    },
  });
}

export function ownerWorkRequestEventMatches(requestValue, eventValue, at) {
  const request = normalizeStoredOwnerWorkRequest(requestValue);
  if (request.schemaVersion === 1) {
    return JSON.stringify(eventValue) === JSON.stringify(
      createOwnerWorkRequestEvent(request, at),
    );
  }
  if (request.schemaVersion === 6) {
    return JSON.stringify(eventValue) === JSON.stringify(
      createOwnerIssueEvent(request, at),
    );
  }
  try {
    const event = normalizeWorkflowEvent({
      schemaVersion: eventValue.schemaVersion,
      eventType: eventValue.eventType,
      occurredAt: eventValue.occurredAt,
      source: structuredClone(eventValue.source),
      subject: structuredClone(eventValue.subject),
      payload: structuredClone(eventValue.payload),
    });
    return Boolean(
      event.eventId === eventValue.eventId &&
      event.contentDigest === eventValue.contentDigest &&
      event.occurredAt === at &&
      event.source.scopeId === `${request.schemaVersion === 7 ? "internal-review" : "owner-request"}:${request.requestId}` &&
      (request.schemaVersion !== 7 || (event.eventType === "pull_request.internal_review_requested" &&
        event.source.provider === "internal-review-repair" &&
        isDeepStrictEqual(event.payload.internalReview, request.internalReview) &&
        event.payload.headRefOid === request.internalReview.headRefOid)) &&
      event.subject.repository === request.pullRequest.repository &&
      event.subject.number === request.pullRequest.number &&
      event.payload.description === request.description &&
      event.payload.workType === request.workType &&
      event.payload.reviewPurpose === request.reviewPurpose &&
      event.payload.priority === request.priority &&
      JSON.stringify(event.payload.acceptanceCriteria) ===
        JSON.stringify(request.acceptanceCriteria) &&
      (request.triage === undefined ||
        (
          event.payload.nextAction === request.triage.nextAction &&
          event.payload.suggestedCapability ===
            request.triage.suggestedCapability &&
          event.payload.expectedHeadRefOid ===
            request.triage.expectedHeadRefOid
        )) &&
      (![3, 4].includes(request.schemaVersion) ||
        JSON.stringify(event.payload.responsiblePerson) ===
          JSON.stringify(request.responsiblePerson))
    );
  } catch {
    return false;
  }
}

export function withOwnerWorkRequestDefaultRoute(definition) {
  const systemRuleIds = new Set([
    OWNER_WORK_REQUEST_DEFAULT_RULE_ID,
    INTERNAL_REVIEW_RULE_ID,
    ...OWNER_PULL_REQUEST_CAPABILITY_ROUTES.map(({ ruleId }) => ruleId),
    ...OWNER_CAPABILITY_ROUTES.map(({ ruleId }) => ruleId),
  ]);
  const rules = Array.isArray(definition?.rules)
    ? definition.rules.filter(
        (rule) => !systemRuleIds.has(rule?.id),
      )
    : definition?.rules;
  return {
    ...definition,
    rules: [
      { id: INTERNAL_REVIEW_RULE_ID, source: "root", enabled: true, priority: 10_000, fallback: false,
        condition: { op: "all", conditions: [
          { op: "equals", path: "eventType", value: "pull_request.internal_review_requested" },
          { op: "equals", path: "source.provider", value: "internal-review-repair" },
        ] }, targets: [{ type: "role", id: "pr-engineer" }], onMatch: "stop" },
      ...OWNER_CAPABILITY_ROUTES.map(({ ruleId, workType, roleId }) => ({
        id: ruleId,
        source: "root",
        enabled: true,
        priority: 10_000,
        fallback: false,
        condition: {
          op: "all",
          conditions: [
            {
              op: "globAny",
              path: "eventType",
              patterns: [OWNER_WORK_REQUEST_EVENT_TYPE, "issue.owner_requested"],
            },
            {
              op: "equals",
              path: "payload.workType",
              value: workType,
            },
          ],
        },
        targets: [{ type: "role", id: roleId }],
        onMatch: "stop",
      })),
      {
        id: OWNER_WORK_REQUEST_DEFAULT_RULE_ID,
        source: "root",
        enabled: true,
        priority: 10_000,
        fallback: false,
        condition: {
          op: "globAny",
          path: "eventType",
          patterns: [OWNER_WORK_REQUEST_EVENT_TYPE, "issue.owner_requested"],
        },
        targets: [{ type: "role", id: "orchestrator" }],
        onMatch: "stop",
      },
      ...OWNER_PULL_REQUEST_CAPABILITY_ROUTES.map(
        ({ ruleId, workType, roleId }) => ({
          id: ruleId,
          source: "root",
          enabled: true,
          priority: 10_000,
          fallback: false,
          condition: {
            op: "all",
            conditions: [
              {
                op: "equals",
                path: "eventType",
                value: "pull_request.owner_requested",
              },
              {
                op: "equals",
                path: "payload.workType",
                value: workType,
              },
            ],
          },
          targets: [{ type: "role", id: roleId }],
          onMatch: "stop",
        }),
      ),
      ...rules,
    ],
  };
}
