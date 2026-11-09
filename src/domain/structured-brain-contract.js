import { normalizeWorkDecision } from "./work-intent.js";
import { permitsCoordinatorCancellation } from "./work-goal-ownership.js";
import {
  ORCHESTRATION_INTENT_JSON_SCHEMA,
  SUBMIT_DELIVERY_INTENT_JSON_SCHEMA,
} from "./orchestration-intent.js";

const DEFAULT_MAXIMUM_BYTES = 128 * 1024;
const MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
const UTF8_MAXIMUM_BYTES_PER_CHARACTER = 4;
const SAFE_TOKEN_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";
const SAFE_DELIVERABLE_ID_PATTERN =
  "^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$";
const CONTROLLED_COMMIT_EVIDENCE_ID_PATTERN =
  "^controlled-git-commit-[a-f0-9]{64}$";
const PROPOSAL_DELIVERABLE_DESCRIPTION =
  "Select the expected deliverable this proposal will produce. " +
  "It is required when the current task has multiple compatible expected " +
  "deliverables; omit it only for legacy/direct work or when exactly " +
  "one compatible deliverable can be selected automatically.";
const ISO_TIMESTAMP_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
const VALID_TEXT_CHARACTER =
  "[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]";
const NON_WHITESPACE_TEXT_CHARACTER =
  "[^\\s\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]";
const VALID_TEXT_PATTERN = `^${VALID_TEXT_CHARACTER}*$`;
const NONEMPTY_TEXT_PATTERN =
  `^${VALID_TEXT_CHARACTER}*${NON_WHITESPACE_TEXT_CHARACTER}` +
  `${VALID_TEXT_CHARACTER}*$`;

export class StructuredBrainContractError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "StructuredBrainContractError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function stringSchema(
  maximumBytes,
  { minimum = 1, ascii = false, pattern, format, description } = {},
) {
  const maxLength = ascii
    ? maximumBytes
    : Math.floor(maximumBytes / UTF8_MAXIMUM_BYTES_PER_CHARACTER);
  return {
    type: "string",
    minLength: minimum,
    maxLength,
    pattern:
      pattern ?? (minimum === 0 ? VALID_TEXT_PATTERN : NONEMPTY_TEXT_PATTERN),
    ...(format ? { format } : {}),
    ...(description ? { description } : {}),
  };
}

function stringArraySchema(maxItems, maxLength, { minimum = 0 } = {}) {
  return {
    type: "array",
    minItems: minimum,
    maxItems,
    items: stringSchema(maxLength),
  };
}

function intentSchema(type, fields, { optional = [] } = {}) {
  const properties = {
    schemaVersion: { type: "integer", const: 1 },
    type: { type: "string", const: type },
    summary: stringSchema(2_048),
    reason: stringSchema(4_096),
    ...fields,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    properties,
  };
}

const evidence = stringArraySchema(20, 2_048);
const pullRequestExternalAction = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "body"],
      properties: {
        type: { type: "string", const: "comment" },
        body: stringSchema(8 * 1_024),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "verdict", "body"],
      properties: {
        type: { type: "string", const: "review" },
        verdict: {
          type: "string",
          enum: ["approve", "request_changes", "comment"],
        },
        body: stringSchema(8 * 1_024),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type"],
      properties: { type: { type: "string", const: "update_branch" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "controlledCommitEvidenceId"],
      properties: {
        type: { type: "string", const: "push" },
        controlledCommitEvidenceId: stringSchema(128, {
          ascii: true,
          pattern: CONTROLLED_COMMIT_EVIDENCE_ID_PATTERN,
        }),
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "method"],
      properties: {
        type: { type: "string", const: "merge" },
        method: { type: "string", enum: ["merge", "squash", "rebase"] },
      },
    },
  ],
};
const intentVariants = [
  intentSchema("ask_user", {
    question: stringSchema(4_096),
    choices: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "description"],
        properties: {
          id: stringSchema(64, { ascii: true, pattern: SAFE_TOKEN_PATTERN }),
          label: stringSchema(256),
          description: stringSchema(1_024, { minimum: 0 }),
        },
      },
    },
  }),
  intentSchema("wait_condition", {
    condition: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "notBefore"],
          properties: {
            kind: { type: "string", const: "time" },
            notBefore: stringSchema(64, {
              ascii: true,
              pattern: ISO_TIMESTAMP_PATTERN,
              format: "date-time",
            }),
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "fact", "oneOf"],
          properties: {
            kind: { type: "string", const: "workflow_fact" },
            fact: stringSchema(64, {
              ascii: true,
              pattern: SAFE_TOKEN_PATTERN,
            }),
            oneOf: {
              ...stringArraySchema(16, 256, { minimum: 1 }),
              uniqueItems: true,
            },
          },
        },
      ],
    },
    checkAfterSeconds: {
      type: "integer",
      minimum: 30,
      maximum: 86_400,
    },
  }),
  intentSchema("query_memory", {
    question: stringSchema(4_096),
    searchQuery: stringSchema(1_024),
    mode: { type: "string", enum: ["local", "configured"] },
  }),
  intentSchema("propose_github_review", {
    deliverableId: stringSchema(128, {
      ascii: true,
      pattern: SAFE_DELIVERABLE_ID_PATTERN,
      description: PROPOSAL_DELIVERABLE_DESCRIPTION,
    }),
    verdict: {
      type: "string",
      enum: ["approve", "request_changes", "comment"],
    },
    body: stringSchema(16 * 1_024),
    evidence,
    publicationReuse: {
      type: "object", additionalProperties: false, required: ["candidateId", "materialDigest", "coverageDigest"],
      properties: {
        candidateId: stringSchema(128, { ascii: true, pattern: "^review-publication-candidate-[a-f0-9]{64}$" }),
        materialDigest: stringSchema(64, { ascii: true, pattern: "^[a-f0-9]{64}$" }),
        coverageDigest: stringSchema(64, { ascii: true, pattern: "^[a-f0-9]{64}$" }),
        readProofId: stringSchema(128, { ascii: true, pattern: "^review-read-proof-[a-f0-9]{64}$" }),
      },
    },
  }, { optional: ["deliverableId", "publicationReuse"] }),
  intentSchema("propose_github_pull_request_action", {
    action: pullRequestExternalAction,
    evidence,
  }),
  intentSchema("propose_code_action", {
    deliverableId: stringSchema(128, {
      ascii: true,
      pattern: SAFE_DELIVERABLE_ID_PATTERN,
      description: PROPOSAL_DELIVERABLE_DESCRIPTION,
    }),
    operation: { type: "string", enum: ["inspect", "modify", "verify"] },
    objective: stringSchema(4_096),
    acceptanceCriteria: stringArraySchema(20, 2_048, { minimum: 1 }),
    evidence,
  }, { optional: ["deliverableId"] }),
  intentSchema("propose_configuration_change", {
    changes: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "value"],
        properties: {
          path: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            items: stringSchema(256),
          },
          value: {
            oneOf: [
              stringSchema(16 * 1_024, { minimum: 0 }),
              { type: "number" },
              { type: "boolean" },
            ],
          },
        },
      },
    },
    evidence,
  }),
  intentSchema("handoff", {
    capability: {
      type: "string",
      enum: [
        "coordination",
        "requirements",
        "pr-review",
        "development",
        "testing",
      ],
    },
    brief: stringSchema(4_096),
    evidence,
  }),
  intentSchema("complete", {
    outcome: { type: "string", enum: ["done", "no-action"] },
    evidence,
  }),
  intentSchema("orchestrate", {
    action: ORCHESTRATION_INTENT_JSON_SCHEMA,
  }),
  SUBMIT_DELIVERY_INTENT_JSON_SCHEMA,
];

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const WORK_DECISION_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "confidence", "summary", "intent"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    summary: stringSchema(4_096),
    intent: { oneOf: intentVariants },
  },
});

const CHILD_WORK_FIELDS = ["capability", "dependsOn", "acceptanceContract"];
const modelOrchestrationSchema = {
  ...ORCHESTRATION_INTENT_JSON_SCHEMA,
  oneOf: ORCHESTRATION_INTENT_JSON_SCHEMA.oneOf.map((variant) => {
    if (variant.properties.type.const !== "decompose") return variant;
    const { capability, dependsOn, acceptanceContract, ...properties } = variant.properties;
    return {
      ...variant,
      required: variant.required.filter(key => !CHILD_WORK_FIELDS.includes(key)),
      properties: {
        ...properties,
        work: {
          ...variant.properties.work,
          required: [...variant.properties.work.required, ...CHILD_WORK_FIELDS],
          properties: { ...variant.properties.work.properties, capability, dependsOn, acceptanceContract },
        },
      },
    };
  }),
};

// Models describe each child in one work object and supply the reason once.
// Persisted commands retain the exact existing domain shape and validation.
export const MODEL_WORK_DECISION_JSON_SCHEMA = deepFreeze({
  ...WORK_DECISION_JSON_SCHEMA,
  properties: {
    ...WORK_DECISION_JSON_SCHEMA.properties,
    intent: {
      oneOf: intentVariants.map((variant) =>
        variant.properties?.type?.const !== "orchestrate" ? variant : {
          ...variant,
          required: variant.required.filter((key) => key !== "reason"),
          properties: { ...Object.fromEntries(Object.entries(variant.properties)
            .filter(([key]) => key !== "reason")), action: modelOrchestrationSchema },
        }),
    },
  },
});

function currentGoalControl(context) {
  const control = context?.requirements?.coordination?.goalControl;
  if (control === undefined) return null;
  if (control === null || control.owner !== "local-owner" || typeof control.rootTaskId !== "string" ||
      !Array.isArray(control.cancellableTaskIds) || control.cancellableTaskIds.some(id => typeof id !== "string")) {
    throw new StructuredBrainContractError("STRUCTURED_BRAIN_RESPONSE_INVALID", "Invalid current coordinator control view");
  }
  return control;
}

export function modelWorkDecisionSchema(context) {
  const control = currentGoalControl(context);
  if (control === null) return MODEL_WORK_DECISION_JSON_SCHEMA;
  // Each request owns its schema. Neither concurrent contexts nor persisted
  // intent contracts can inherit another goal's cancellation targets.
  const schema = structuredClone(MODEL_WORK_DECISION_JSON_SCHEMA);
  const orchestration = schema.properties.intent.oneOf.find(variant => variant.properties.type.const === "orchestrate");
  orchestration.properties.action.oneOf = orchestration.properties.action.oneOf.filter(variant => {
    if (variant.properties.type.const !== "cancel") return true;
    if (control.cancellableTaskIds.length === 0) return false;
    variant.properties.sourceTaskId.enum = [...control.cancellableTaskIds];
    return true;
  });
  return deepFreeze(schema);
}

export function assertModelWorkDecisionControls(decision, context) {
  const action = decision.intent.type === "orchestrate" ? decision.intent.action : null;
  if (action?.type === "cancel" && !permitsCoordinatorCancellation(currentGoalControl(context), action.sourceTaskId)) {
    throw new StructuredBrainContractError("STRUCTURED_BRAIN_RESPONSE_INVALID", "Cancel target is outside current coordinator controls");
  }
}

function maximumBytesFrom(options) {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new TypeError("structured brain parser options are invalid");
  }
  const keys = Reflect.ownKeys(options);
  if (
    keys.some((key) => key !== "maximumBytes") ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) {
    throw new TypeError("structured brain parser options are invalid");
  }
  const maximumBytes = Object.hasOwn(options, "maximumBytes")
    ? Object.getOwnPropertyDescriptor(options, "maximumBytes").value
    : DEFAULT_MAXIMUM_BYTES;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAXIMUM_RESPONSE_BYTES
  ) {
    throw new TypeError("maximumBytes is outside the supported range");
  }
  return maximumBytes;
}

function parseWorkDecision(text, options, normalize) {
  const maximumBytes = maximumBytesFrom(options);
  if (typeof text !== "string") {
    throw new StructuredBrainContractError(
      "STRUCTURED_BRAIN_RESPONSE_INVALID",
      "Structured brain response is invalid",
    );
  }
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new StructuredBrainContractError(
      "STRUCTURED_BRAIN_RESPONSE_TOO_LARGE",
      "Structured brain response exceeds the configured limit",
      413,
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StructuredBrainContractError(
      "STRUCTURED_BRAIN_RESPONSE_INVALID",
      "Structured brain response is invalid",
    );
  }
  try {
    return normalize(value);
  } catch {
    throw new StructuredBrainContractError(
      "STRUCTURED_BRAIN_RESPONSE_INVALID",
      "Structured brain response is invalid",
    );
  }
}

export function parseStructuredWorkDecision(text, options = {}) {
  return parseWorkDecision(text, options, normalizeWorkDecision);
}

export function parseModelWorkDecision(text, options = {}) {
  return parseWorkDecision(text, options, (value) => {
    const action = value?.intent?.type === "orchestrate" ? value.intent.action : null;
    if (action?.type === "decompose" && action.work &&
        CHILD_WORK_FIELDS.some(key => Object.hasOwn(action.work, key))) {
      if (CHILD_WORK_FIELDS.some(key => Object.hasOwn(action, key) || !Object.hasOwn(action.work, key))) {
        throw new Error("Ambiguous or incomplete model child work");
      }
      const { capability, dependsOn, acceptanceContract, ...work } = action.work;
      value = { ...value, intent: { ...value.intent,
        action: { ...action, work, capability, dependsOn, acceptanceContract } } };
    }
    if (value?.intent?.type === "orchestrate" && !Object.hasOwn(value.intent, "reason")) {
      value = { ...value, intent: { ...value.intent, reason: value.intent.action?.reason } };
    }
    // Legacy decisions with both fields remain subject to exact equality;
    // never overwrite a conflicting model-supplied value.
    return normalizeWorkDecision(value);
  });
}
