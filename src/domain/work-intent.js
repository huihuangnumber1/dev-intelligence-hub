import { createHash } from "node:crypto";
import {
  normalizeOrchestrationIntent,
  normalizeSubmitDeliveryIntent,
} from "./orchestration-intent.js";

const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SAFE_DELIVERABLE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const DISPATCH_INTENT_ID = /^work-dispatch-intent-[a-f0-9]{64}$/;
const INTENT_TYPES = new Set([
  "ask_user",
  "wait_condition",
  "query_memory",
  "propose_github_review",
  "propose_github_pull_request_action",
  "propose_code_action",
  "propose_configuration_change",
  "handoff",
  "complete",
  "orchestrate",
  "submit_delivery",
]);
const REVIEW_VERDICTS = new Set(["approve", "request_changes", "comment"]);
const PULL_REQUEST_ACTION_TYPES = new Set([
  "comment",
  "review",
  "update_branch",
  "push",
  "merge",
]);
const PULL_REQUEST_MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
const CONTROLLED_COMMIT_EVIDENCE_ID =
  /^controlled-git-commit-[a-f0-9]{64}$/;
const CODE_OPERATIONS = new Set(["inspect", "modify", "verify"]);
const DANGEROUS_CONFIGURATION_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
const CREDENTIAL_VALUE = /^(?:bearer\s+|gh[pousr]_|github_pat_|sk-|AKIA)[^\s]+$/i;
const PRIVATE_KEY_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const HANDOFF_CAPABILITIES = new Set([
  "coordination",
  "requirements",
  "pr-review",
  "development",
  "testing",
]);
const COMPLETE_OUTCOMES = new Set(["done", "no-action"]);
const MAX_INTENT_BYTES = 64 * 1024;

export class WorkIntentError extends Error {
  constructor(message = "员工工作意图无效") {
    super(message);
    this.name = "WorkIntentError";
    this.code = "WORK_INTENT_INVALID";
    this.statusCode = 400;
  }
}

function invalid(message) {
  throw new WorkIntentError(message);
}

function plainDataEntries(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid();
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      invalid();
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactObject(value, keys) {
  const entries = plainDataEntries(value);
  const actual = entries.map(([key]) => key);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key))
  ) {
    invalid();
  }
  return new Map(entries);
}

function plainArray(value, maximum) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    invalid();
  }
  const expected = Array.from({ length: value.length }, (_, index) => `${index}`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length + 1 ||
    !keys.includes("length") ||
    expected.some((key) => !keys.includes(key))
  ) {
    invalid();
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
  }
  return value;
}

function text(value, name, maximum, { empty = false } = {}) {
  if (
    typeof value !== "string" ||
    INVALID_CONTROL.test(value) ||
    (!empty && value.trim().length === 0) ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    invalid(`${name} 无效`);
  }
  return value;
}

function token(value, name) {
  const normalized = text(value, name, 64);
  if (!SAFE_TOKEN.test(normalized)) invalid(`${name} 无效`);
  return normalized;
}

function stringList(value, name, maximumItems, maximumBytes, { empty = true } = {}) {
  const entries = plainArray(value, maximumItems).map((entry) =>
    text(entry, name, maximumBytes, { empty: false }),
  );
  if (!empty && entries.length === 0) invalid(`${name} 不能为空`);
  return entries;
}

function common(value, expectedKeys) {
  const entries = exactObject(value, expectedKeys);
  if (entries.get("schemaVersion") !== 1) invalid("schemaVersion 无效");
  const type = entries.get("type");
  if (!INTENT_TYPES.has(type)) invalid("type 无效");
  return {
    schemaVersion: 1,
    type,
    summary: text(entries.get("summary"), "summary", 2_048),
    reason: text(entries.get("reason"), "reason", 4_096),
  };
}

function normalizeChoices(value) {
  const choices = plainArray(value, 8).map((choice) => {
    const entries = exactObject(choice, ["id", "label", "description"]);
    return {
      id: token(entries.get("id"), "choice.id"),
      label: text(entries.get("label"), "choice.label", 256),
      description: text(
        entries.get("description"),
        "choice.description",
        1_024,
        { empty: true },
      ),
    };
  });
  if (new Set(choices.map(({ id }) => id)).size !== choices.length) {
    invalid("choice.id 重复");
  }
  return choices;
}

function normalizeCondition(value) {
  const typeEntries = plainDataEntries(value);
  const kindEntry = typeEntries.find(([key]) => key === "kind");
  const kind = kindEntry?.[1];
  if (kind === "time") {
    const entries = exactObject(value, ["kind", "notBefore"]);
    const notBefore = text(entries.get("notBefore"), "notBefore", 64);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(notBefore) ||
      !Number.isFinite(Date.parse(notBefore)) ||
      new Date(Date.parse(notBefore)).toISOString() !== notBefore
    ) {
      invalid("notBefore 无效");
    }
    return { kind: "time", notBefore };
  }
  if (kind === "workflow_fact") {
    const entries = exactObject(value, ["kind", "fact", "oneOf"]);
    const oneOf = stringList(entries.get("oneOf"), "condition.oneOf", 16, 256, {
      empty: false,
    });
    if (new Set(oneOf).size !== oneOf.length) invalid("condition.oneOf 重复");
    return {
      kind: "workflow_fact",
      fact: token(entries.get("fact"), "condition.fact"),
      oneOf,
    };
  }
  invalid("condition.kind 无效");
}

function normalizeEvidence(value) {
  return stringList(value, "evidence", 20, 2_048);
}

function credentialConfigurationPathSegment(value) {
  const normalized = value.replaceAll(/[-_]/g, "").toLowerCase();
  return (
    [
      "password",
      "secret",
      "token",
      "credential",
      "apikey",
      "privatekey",
      "accesskey",
      "clientsecret",
      "credentialenv",
      "tokenenv",
      "apikeyenv",
      "networkenv",
      "actoraccountid",
      "accountid",
      "githublogin",
      "selfuserid",
    ].includes(normalized) ||
    normalized.endsWith("credentialenv") ||
    normalized.endsWith("tokenenv") ||
    normalized.endsWith("apikeyenv") ||
    normalized.endsWith("actoraccountid")
  );
}

function disablesConfigurationProposalRecovery(path) {
  return (
    path.length === 2 &&
    path[0] === "workCoordination" &&
    path[1] === "enabled"
  );
}

function normalizeConfigurationScalar(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = text(value, "changes.value", 16 * 1_024, { empty: true });
    if (CREDENTIAL_VALUE.test(normalized) || PRIVATE_KEY_VALUE.test(normalized)) {
      invalid("changes.value 不得包含凭据");
    }
    return normalized;
  }
  invalid("changes.value 必须是字符串、数字或布尔值");
}

function normalizeConfigurationChanges(value) {
  const changes = plainArray(value, 20).map((change) => {
    const entries = exactObject(change, ["path", "value"]);
    const path = plainArray(entries.get("path"), 16).map((segment) => {
      const normalized = text(segment, "changes.path", 256);
      if (
        DANGEROUS_CONFIGURATION_PATH_SEGMENTS.has(normalized) ||
        credentialConfigurationPathSegment(normalized)
      ) {
        invalid("changes.path 不得指向危险或凭据字段");
      }
      return normalized;
    });
    if (path.length === 0) invalid("changes.path 不能为空");
    if (disablesConfigurationProposalRecovery(path)) {
      invalid("changes.path 不得关闭配置提案恢复边界");
    }
    return { path, value: normalizeConfigurationScalar(entries.get("value")) };
  });
  if (changes.length === 0) invalid("changes 不能为空");
  const paths = changes.map(({ path }) => JSON.stringify(path));
  if (new Set(paths).size !== paths.length) invalid("changes.path 重复");
  return changes;
}

function normalizePullRequestAction(value) {
  const entries = plainDataEntries(value);
  const type = entries.find(([key]) => key === "type")?.[1];
  if (!PULL_REQUEST_ACTION_TYPES.has(type)) invalid("action.type 无效");
  if (type === "comment") {
    const fields = exactObject(value, ["type", "body"]);
    return {
      type,
      body: text(fields.get("body"), "action.body", 8 * 1_024),
    };
  }
  if (type === "review") {
    const fields = exactObject(value, ["type", "verdict", "body"]);
    const verdict = fields.get("verdict");
    if (!REVIEW_VERDICTS.has(verdict)) invalid("action.verdict 无效");
    return {
      type,
      verdict,
      body: text(fields.get("body"), "action.body", 8 * 1_024),
    };
  }
  if (type === "update_branch") {
    exactObject(value, ["type"]);
    return { type };
  }
  if (type === "push") {
    const fields = exactObject(value, ["type", "controlledCommitEvidenceId"]);
    const controlledCommitEvidenceId = fields.get("controlledCommitEvidenceId");
    if (
      typeof controlledCommitEvidenceId !== "string" ||
      !CONTROLLED_COMMIT_EVIDENCE_ID.test(controlledCommitEvidenceId)
    ) {
      invalid("action.controlledCommitEvidenceId 无效");
    }
    return { type, controlledCommitEvidenceId };
  }
  const fields = exactObject(value, ["type", "method"]);
  const method = fields.get("method");
  if (!PULL_REQUEST_MERGE_METHODS.has(method)) {
    invalid("action.method 无效");
  }
  return { type, method };
}

function proposalKeys(entries, requiredKeys) {
  const actual = new Set(entries.map(([key]) => key));
  return [
    ...requiredKeys,
    ...["deliverableId", "dispatchIntentId"].filter((key) => actual.has(key)),
  ];
}

function externalActionProposalKeys(entries, requiredKeys) {
  const actual = new Set(entries.map(([key]) => key));
  return [
    ...requiredKeys,
    ...["dispatchIntentId"].filter((key) => actual.has(key)),
  ];
}

function proposalAuthority(entries) {
  return {
    ...(entries.has("deliverableId")
      ? {
          deliverableId: text(
            entries.get("deliverableId"),
            "deliverableId",
            128,
          ),
        }
      : {}),
    ...(entries.has("dispatchIntentId")
      ? {
          dispatchIntentId: text(
            entries.get("dispatchIntentId"),
            "dispatchIntentId",
            128,
          ),
        }
      : {}),
  };
}

function assertProposalAuthority(authority) {
  if (
    authority.deliverableId !== undefined &&
    !SAFE_DELIVERABLE_ID.test(authority.deliverableId)
  ) {
    invalid("deliverableId 无效");
  }
  if (
    authority.dispatchIntentId !== undefined &&
    !DISPATCH_INTENT_ID.test(authority.dispatchIntentId)
  ) {
    invalid("dispatchIntentId 无效");
  }
  return authority;
}

function orchestrationAction(value) {
  try {
    return normalizeOrchestrationIntent(value);
  } catch {
    invalid("action 无效");
  }
}

function specialistDeliveryIntent(value) {
  try {
    return normalizeSubmitDeliveryIntent(value);
  } catch {
    invalid("submit_delivery intent 无效");
  }
}

function normalizeIntentVariant(value) {
  const typeEntries = plainDataEntries(value);
  const type = typeEntries.find(([key]) => key === "type")?.[1];
  switch (type) {
    case "ask_user": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "question",
        "choices",
      ];
      const entries = exactObject(value, keys);
      return {
        ...common(value, keys),
        question: text(entries.get("question"), "question", 4_096),
        choices: normalizeChoices(entries.get("choices")),
      };
    }
    case "wait_condition": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "condition",
        "checkAfterSeconds",
      ];
      const entries = exactObject(value, keys);
      const checkAfterSeconds = entries.get("checkAfterSeconds");
      if (
        !Number.isSafeInteger(checkAfterSeconds) ||
        checkAfterSeconds < 30 ||
        checkAfterSeconds > 86_400
      ) {
        invalid("checkAfterSeconds 无效");
      }
      return {
        ...common(value, keys),
        condition: normalizeCondition(entries.get("condition")),
        checkAfterSeconds,
      };
    }
    case "query_memory": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "question",
        "searchQuery",
        "mode",
      ];
      const entries = exactObject(value, keys);
      const mode = entries.get("mode");
      if (!new Set(["local", "configured"]).has(mode)) {
        invalid("mode 无效");
      }
      return {
        ...common(value, keys),
        question: text(entries.get("question"), "question", 4_096),
        searchQuery: text(entries.get("searchQuery"), "searchQuery", 1_024),
        mode,
      };
    }
    case "propose_github_review": {
      const keys = proposalKeys(typeEntries, [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "verdict",
        "body",
        "evidence",
      ]);
      if (typeEntries.some(([key]) => key === "publicationReuse")) keys.push("publicationReuse");
      const entries = exactObject(value, keys);
      let publicationReuse;
      if (entries.has("publicationReuse")) {
        const rawReuse = entries.get("publicationReuse");
        const reuse = exactObject(rawReuse, ["candidateId", "materialDigest", "coverageDigest",
          ...(rawReuse !== null && typeof rawReuse === "object" && Object.hasOwn(rawReuse, "readProofId") ? ["readProofId"] : [])]);
        const candidateId = text(reuse.get("candidateId"), "publicationReuse.candidateId", 128);
        const materialDigest = text(reuse.get("materialDigest"), "publicationReuse.materialDigest", 64);
        const coverageDigest = text(reuse.get("coverageDigest"), "publicationReuse.coverageDigest", 64);
        if (!/^review-publication-candidate-[a-f0-9]{64}$/.test(candidateId) ||
            !/^[a-f0-9]{64}$/.test(materialDigest) || !/^[a-f0-9]{64}$/.test(coverageDigest)) invalid("publicationReuse binding is invalid");
        publicationReuse = { candidateId, materialDigest, coverageDigest };
        if (reuse.has("readProofId")) {
          const readProofId = text(reuse.get("readProofId"), "publicationReuse.readProofId", 128);
          if (!/^review-read-proof-[a-f0-9]{64}$/.test(readProofId)) invalid("publicationReuse read proof is invalid");
          publicationReuse.readProofId = readProofId;
        }
      }
      const verdict = entries.get("verdict");
      if (!REVIEW_VERDICTS.has(verdict)) invalid("verdict 无效");
      return {
        ...common(value, keys),
        ...assertProposalAuthority(proposalAuthority(entries)),
        verdict,
        body: text(entries.get("body"), "body", 16 * 1024),
        evidence: normalizeEvidence(entries.get("evidence")),
        ...(publicationReuse === undefined ? {} : { publicationReuse }),
      };
    }
    case "propose_github_pull_request_action": {
      const keys = externalActionProposalKeys(typeEntries, [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "action",
        "evidence",
      ]);
      const entries = exactObject(value, keys);
      return {
        ...common(value, keys),
        ...assertProposalAuthority(proposalAuthority(entries)),
        action: normalizePullRequestAction(entries.get("action")),
        evidence: normalizeEvidence(entries.get("evidence")),
      };
    }
    case "propose_code_action": {
      const keys = proposalKeys(typeEntries, [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "operation",
        "objective",
        "acceptanceCriteria",
        "evidence",
      ]);
      const entries = exactObject(value, keys);
      const operation = entries.get("operation");
      if (!CODE_OPERATIONS.has(operation)) invalid("operation 无效");
      return {
        ...common(value, keys),
        ...assertProposalAuthority(proposalAuthority(entries)),
        operation,
        objective: text(entries.get("objective"), "objective", 4_096),
        acceptanceCriteria: stringList(
          entries.get("acceptanceCriteria"),
          "acceptanceCriteria",
          20,
          2_048,
          { empty: false },
        ),
        evidence: normalizeEvidence(entries.get("evidence")),
      };
    }
    case "propose_configuration_change": {
      const keys = externalActionProposalKeys(typeEntries, [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "changes",
        "evidence",
      ]);
      const entries = exactObject(value, keys);
      return {
        ...common(value, keys),
        ...assertProposalAuthority(proposalAuthority(entries)),
        changes: normalizeConfigurationChanges(entries.get("changes")),
        evidence: normalizeEvidence(entries.get("evidence")),
      };
    }
    case "handoff": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "capability",
        "brief",
        "evidence",
      ];
      const entries = exactObject(value, keys);
      const capability = entries.get("capability");
      if (!HANDOFF_CAPABILITIES.has(capability)) invalid("capability 无效");
      return {
        ...common(value, keys),
        capability,
        brief: text(entries.get("brief"), "brief", 4_096),
        evidence: normalizeEvidence(entries.get("evidence")),
      };
    }
    case "complete": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "outcome",
        "evidence",
      ];
      const entries = exactObject(value, keys);
      const outcome = entries.get("outcome");
      if (!COMPLETE_OUTCOMES.has(outcome)) invalid("outcome 无效");
      return {
        ...common(value, keys),
        outcome,
        evidence: normalizeEvidence(entries.get("evidence")),
      };
    }
    case "orchestrate": {
      const keys = [
        "schemaVersion",
        "type",
        "summary",
        "reason",
        "action",
      ];
      const entries = exactObject(value, keys);
      const normalizedCommon = common(value, keys);
      const action = orchestrationAction(entries.get("action"));
      if (normalizedCommon.reason !== action.reason) {
        invalid("orchestrate reason 必须与 action.reason 一致");
      }
      return { ...normalizedCommon, action };
    }
    case "submit_delivery":
      return specialistDeliveryIntent(value);
    default:
      invalid("type 无效");
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function normalizeWorkIntent(value) {
  const intent = normalizeIntentVariant(value);
  if (Buffer.byteLength(JSON.stringify(intent), "utf8") > MAX_INTENT_BYTES) {
    invalid("员工工作意图过大");
  }
  return intent;
}

export function normalizeWorkDecision(value) {
  const entries = exactObject(value, [
    "schemaVersion",
    "confidence",
    "summary",
    "intent",
  ]);
  if (entries.get("schemaVersion") !== 1) invalid("schemaVersion 无效");
  const confidence = entries.get("confidence");
  if (!Number.isSafeInteger(confidence) || confidence < 0 || confidence > 100) {
    invalid("confidence 无效");
  }
  return {
    schemaVersion: 1,
    confidence,
    summary: text(entries.get("summary"), "decision.summary", 4_096),
    intent: normalizeWorkIntent(entries.get("intent")),
  };
}

export function workIntentDigest(value) {
  const intent = normalizeWorkIntent(value);
  return createHash("sha256")
    .update(JSON.stringify(stableValue(intent)), "utf8")
    .digest("hex");
}
