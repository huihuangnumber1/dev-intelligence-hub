import { createHash } from "node:crypto";

import { normalizeWorkGraphAcceptanceContract } from "./work-graph-contract.js";
import {
  REQUIREMENT_SPEC_DRAFT_JSON_SCHEMA,
  normalizeRequirementSpecDraft,
} from "./requirement-spec-contract.js";

const INVALID_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_TASK_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,190}[A-Za-z0-9])?$/;
const SAFE_CHILD_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SAFE_REFERENCE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,510}[A-Za-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ORCHESTRATION_TYPES = new Set([
  "decompose",
  "assign",
  "accept_delivery",
  "return_delivery",
  "escalate",
  "pause",
  "resume",
  "cancel",
]);
const MAX_ORCHESTRATION_INTENT_BYTES = 64 * 1_024;
const MAX_SUBMIT_DELIVERY_INTENT_BYTES = 64 * 1_024;
const MAX_DEPENDENCIES = 64;
const MAX_CHOICES = 8;
const MAX_CALLER_EVIDENCE = 30;
const RESERVED_CALLER_EVIDENCE_KINDS = [
  "work-inputs",
  "requirement-spec",
];
const TRUSTED_DELIVERABLE_KINDS = new Set([
  "requirement-spec",
  "text-report",
  "change-package",
  "test-report",
  "review-report",
  "github-review",
]);

export class OrchestrationIntentError extends Error {
  constructor(message = "编排意图无效") {
    super(message);
    this.name = "OrchestrationIntentError";
    this.code = "ORCHESTRATION_INTENT_INVALID";
    this.statusCode = 400;
  }
}

function invalid(message) {
  throw new OrchestrationIntentError(message);
}

function plainDataEntries(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${name} 无效`);
  }
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    ) {
      invalid(`${name} 无效`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function exactObject(value, keys, name) {
  const entries = plainDataEntries(value, name);
  const actual = new Set(entries.map(([key]) => key));
  if (actual.size !== keys.length || keys.some((key) => !actual.has(key))) {
    invalid(`${name} 无效`);
  }
  return new Map(entries);
}

function denseArray(value, maximum, name, { minimum = 0 } = {}) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum
  ) {
    invalid(`${name} 无效`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    invalid(`${name} 无效`);
  }
  const entries = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid(`${name} 无效`);
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function boundedText(value, name, maximumBytes, pattern = null) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    INVALID_CONTROL.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    (pattern !== null && !pattern.test(value))
  ) {
    invalid(`${name} 无效`);
  }
  return value;
}

function boundedTaskId(value, name) {
  return boundedText(value, name, 192, SAFE_TASK_ID);
}

function boundedCapability(value) {
  return boundedText(value, "capability", 128, SAFE_TOKEN);
}

function positiveRevision(value, name, { zero = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < (zero ? 0 : 1)
  ) {
    invalid(`${name} 无效`);
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function valueDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function assertSerializedLimit(value, maximum, name) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    invalid(`${name} 过大`);
  }
}

function commonIntent(entries, type) {
  if (entries.get("schemaVersion") !== 1 || !ORCHESTRATION_TYPES.has(type)) {
    invalid("schemaVersion 或 type 无效");
  }
  return {
    schemaVersion: 1,
    type,
    sourceTaskId: boundedTaskId(
      entries.get("sourceTaskId"),
      "sourceTaskId",
    ),
    sourceTaskRevision: positiveRevision(
      entries.get("sourceTaskRevision"),
      "sourceTaskRevision",
    ),
    expectedGraphRevision: positiveRevision(
      entries.get("expectedGraphRevision"),
      "expectedGraphRevision",
      { zero: true },
    ),
    reason: boundedText(entries.get("reason"), "reason", 4_096),
  };
}

function normalizeChildWork(value) {
  const work = exactObject(value, ["title", "description"], "work");
  return {
    title: boundedText(work.get("title"), "work.title", 256),
    description: boundedText(
      work.get("description"),
      "work.description",
      16 * 1_024,
    ),
  };
}

function normalizeDependencies(value) {
  const dependencies = denseArray(
    value,
    MAX_DEPENDENCIES,
    "dependsOn",
  ).map((entry) => {
    const dependency = exactObject(entry, ["taskId", "revision"], "dependency");
    return {
      taskId: boundedTaskId(dependency.get("taskId"), "dependsOn.taskId"),
      revision: positiveRevision(
        dependency.get("revision"),
        "dependsOn.revision",
      ),
    };
  });
  const taskIds = dependencies.map(({ taskId }) => taskId);
  if (new Set(taskIds).size !== taskIds.length) invalid("dependsOn.taskId 重复");
  return dependencies.sort((left, right) => compareText(left.taskId, right.taskId));
}

function assertPlainAcceptanceContract(value) {
  const contract = exactObject(value, [
    "revision",
    "acceptanceCriteria",
    "expectedDeliverables",
  ], "acceptanceContract");
  for (const criterion of denseArray(
    contract.get("acceptanceCriteria"),
    64,
    "acceptanceCriteria",
  )) {
    exactObject(criterion, ["criterionId", "description"], "criterion");
  }
  for (const deliverable of denseArray(
    contract.get("expectedDeliverables"),
    64,
    "expectedDeliverables",
  )) {
    exactObject(
      deliverable,
      ["deliverableId", "kind", "description", "required"],
      "expected deliverable",
    );
  }
}

function normalizeInitialAcceptanceContract(value) {
  assertPlainAcceptanceContract(value);
  let contract;
  try {
    contract = normalizeWorkGraphAcceptanceContract(value);
  } catch {
    invalid("acceptanceContract 无效");
  }
  if (contract.revision !== 1) invalid("acceptanceContract.revision 必须为 1");
  for (const deliverable of contract.expectedDeliverables) {
    if (!TRUSTED_DELIVERABLE_KINDS.has(deliverable.kind)) {
      invalid("acceptanceContract deliverable.kind 无效");
    }
    if (
      (deliverable.deliverableId === "requirement-spec") !==
      (deliverable.kind === "requirement-spec")
    ) {
      invalid("requirement-spec deliverableId 与 kind 必须一致");
    }
  }
  return contract;
}

function normalizeChoice(value) {
  const choice = exactObject(value, ["id", "label", "description"], "choice");
  return {
    id: boundedText(choice.get("id"), "choice.id", 128, SAFE_TOKEN),
    label: boundedText(choice.get("label"), "choice.label", 256),
    description: boundedText(
      choice.get("description"),
      "choice.description",
      1_024,
    ),
  };
}

function normalizeChoices(value) {
  const choices = denseArray(value, MAX_CHOICES, "choices", { minimum: 1 })
    .map(normalizeChoice);
  if (new Set(choices.map(({ id }) => id)).size !== choices.length) {
    invalid("choice.id 重复");
  }
  return choices;
}

function orchestrationIntentVariant(value) {
  const type = plainDataEntries(value, "orchestration intent")
    .find(([key]) => key === "type")?.[1];
  const commonKeys = [
    "schemaVersion",
    "type",
    "sourceTaskId",
    "sourceTaskRevision",
    "expectedGraphRevision",
    "reason",
  ];
  switch (type) {
    case "decompose": {
      const entries = exactObject(value, [
        ...commonKeys,
        "childKey",
        "work",
        "capability",
        "dependsOn",
        "acceptanceContract",
      ], "decompose intent");
      return {
        ...commonIntent(entries, type),
        childKey: boundedText(
          entries.get("childKey"),
          "childKey",
          128,
          SAFE_CHILD_KEY,
        ),
        work: normalizeChildWork(entries.get("work")),
        capability: boundedCapability(entries.get("capability")),
        dependsOn: normalizeDependencies(entries.get("dependsOn")),
        acceptanceContract: normalizeInitialAcceptanceContract(
          entries.get("acceptanceContract"),
        ),
      };
    }
    case "assign": {
      const entries = exactObject(
        value,
        [...commonKeys, "capability"],
        "assign intent",
      );
      return {
        ...commonIntent(entries, type),
        capability: boundedCapability(entries.get("capability")),
      };
    }
    case "accept_delivery":
    case "return_delivery": {
      const entries = exactObject(
        value,
        [...commonKeys, "submittedDeliveryRevision"],
        `${type} intent`,
      );
      return {
        ...commonIntent(entries, type),
        submittedDeliveryRevision: positiveRevision(
          entries.get("submittedDeliveryRevision"),
          "submittedDeliveryRevision",
        ),
      };
    }
    case "escalate": {
      const entries = exactObject(
        value,
        [...commonKeys, "question", "choices"],
        "escalate intent",
      );
      return {
        ...commonIntent(entries, type),
        question: boundedText(entries.get("question"), "question", 4_096),
        choices: normalizeChoices(entries.get("choices")),
      };
    }
    case "pause": {
      const hasChildWait = plainDataEntries(value, "pause intent")
        .some(([key]) => key === "waitForChildren");
      const entries = exactObject(
        value,
        hasChildWait ? [...commonKeys, "waitForChildren"] : commonKeys,
        "pause intent",
      );
      if (hasChildWait && entries.get("waitForChildren") !== true) {
        invalid("waitForChildren 必须为 true");
      }
      return {
        ...commonIntent(entries, type),
        ...(hasChildWait ? { waitForChildren: true } : {}),
      };
    }
    case "resume":
    case "cancel": {
      const entries = exactObject(value, commonKeys, `${type} intent`);
      return commonIntent(entries, type);
    }
    default:
      invalid("type 无效");
  }
}

export function normalizeOrchestrationIntent(value) {
  const intent = orchestrationIntentVariant(value);
  assertSerializedLimit(
    intent,
    MAX_ORCHESTRATION_INTENT_BYTES,
    "orchestration intent",
  );
  return deepFreeze(intent);
}

export function orchestrationIntentDigest(value) {
  return valueDigest(normalizeOrchestrationIntent(value));
}

function normalizeEvidence(value) {
  const evidence = denseArray(
    value,
    MAX_CALLER_EVIDENCE,
    "evidence",
  ).map((entry) => {
    const record = exactObject(
      entry,
      ["kind", "referenceId", "contentDigest"],
      "evidence record",
    );
    const kind = boundedText(record.get("kind"), "evidence.kind", 128, SAFE_TOKEN);
    if (RESERVED_CALLER_EVIDENCE_KINDS.includes(kind)) {
      invalid(`${kind} evidence 只能由可信服务生成`);
    }
    return {
      kind,
      referenceId: boundedText(
        record.get("referenceId"),
        "evidence.referenceId",
        512,
        SAFE_REFERENCE_ID,
      ),
      contentDigest: boundedText(
        record.get("contentDigest"),
        "evidence.contentDigest",
        64,
        SHA256,
      ),
    };
  });
  const keys = evidence.map(
    ({ kind, referenceId, contentDigest }) =>
      `${kind}:${referenceId}:${contentDigest}`,
  );
  if (new Set(keys).size !== keys.length) invalid("evidence 重复");
  return evidence.sort((left, right) => compareText(
    `${left.kind}:${left.referenceId}:${left.contentDigest}`,
    `${right.kind}:${right.referenceId}:${right.contentDigest}`,
  ));
}

function normalizeArtifact(value, deliverableId) {
  if (deliverableId !== "requirement-spec") {
    if (value !== null) invalid("artifact 与 deliverableId 不匹配");
    return null;
  }
  if (value === null) invalid("artifact 与 deliverableId 不匹配");
  try {
    return normalizeRequirementSpecDraft(value);
  } catch {
    invalid("artifact 无效");
  }
}

export function normalizeSubmitDeliveryIntent(value) {
  const entries = exactObject(value, [
    "schemaVersion",
    "type",
    "taskId",
    "expectedTaskRevision",
    "expectedGraphRevision",
    "contractRevision",
    "deliverableId",
    "summary",
    "reason",
    "evidence",
    "artifact",
  ], "submit delivery intent");
  if (
    entries.get("schemaVersion") !== 1 ||
    entries.get("type") !== "submit_delivery"
  ) {
    invalid("schemaVersion 或 type 无效");
  }
  const deliverableId = boundedText(
    entries.get("deliverableId"),
    "deliverableId",
    128,
    SAFE_TOKEN,
  );
  const intent = {
    schemaVersion: 1,
    type: "submit_delivery",
    taskId: boundedTaskId(entries.get("taskId"), "taskId"),
    expectedTaskRevision: positiveRevision(
      entries.get("expectedTaskRevision"),
      "expectedTaskRevision",
    ),
    expectedGraphRevision: positiveRevision(
      entries.get("expectedGraphRevision"),
      "expectedGraphRevision",
      { zero: true },
    ),
    contractRevision: positiveRevision(
      entries.get("contractRevision"),
      "contractRevision",
    ),
    deliverableId,
    summary: boundedText(entries.get("summary"), "summary", 16 * 1_024),
    reason: boundedText(entries.get("reason"), "reason", 4_096),
    evidence: normalizeEvidence(entries.get("evidence")),
    artifact: normalizeArtifact(entries.get("artifact"), deliverableId),
  };
  assertSerializedLimit(
    intent,
    MAX_SUBMIT_DELIVERY_INTENT_BYTES,
    "submit delivery intent",
  );
  return deepFreeze(intent);
}

export function submitDeliveryIntentDigest(value) {
  return valueDigest(normalizeSubmitDeliveryIntent(value));
}

const VALID_TEXT_PATTERN =
  "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*" +
  "[^\\s\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]" +
  "[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$";
const UTF8_MAXIMUM_BYTES_PER_CHARACTER = 4;

function stringSchema(maximumBytes, pattern = VALID_TEXT_PATTERN) {
  const ascii = pattern !== VALID_TEXT_PATTERN;
  return {
    type: "string",
    minLength: 1,
    maxLength: ascii
      ? maximumBytes
      : Math.floor(maximumBytes / UTF8_MAXIMUM_BYTES_PER_CHARACTER),
    pattern,
  };
}

const revisionSchema = { type: "integer", minimum: 1 };
const graphRevisionSchema = { type: "integer", minimum: 0 };
const commonProperties = {
  schemaVersion: { type: "integer", const: 1 },
  sourceTaskId: stringSchema(192, SAFE_TASK_ID.source),
  sourceTaskRevision: revisionSchema,
  expectedGraphRevision: graphRevisionSchema,
  reason: stringSchema(4_096),
};

function orchestrationSchema(type, additionalProperties = {}) {
  const properties = {
    ...commonProperties,
    type: { type: "string", const: type },
    ...additionalProperties,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const criterionProperties = {
  criterionId: stringSchema(128, SAFE_TOKEN.source),
  description: stringSchema(4_096),
};
const deliverableProperties = {
  deliverableId: stringSchema(128, SAFE_TOKEN.source),
  kind: {
    type: "string",
    enum: [...TRUSTED_DELIVERABLE_KINDS],
  },
  description: stringSchema(4_096),
  required: { type: "boolean" },
};
const acceptanceContractSchema = {
  type: "object",
  additionalProperties: false,
  required: ["revision", "acceptanceCriteria", "expectedDeliverables"],
  properties: {
    revision: { type: "integer", const: 1 },
    acceptanceCriteria: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(criterionProperties),
        properties: criterionProperties,
      },
    },
    expectedDeliverables: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(deliverableProperties),
        properties: deliverableProperties,
      },
    },
  },
};

const choiceProperties = {
  id: stringSchema(128, SAFE_TOKEN.source),
  label: stringSchema(256),
  description: stringSchema(1_024),
};

export const ORCHESTRATION_INTENT_JSON_SCHEMA = deepFreeze({
  oneOf: [
    orchestrationSchema("decompose", {
      childKey: stringSchema(128, SAFE_CHILD_KEY.source),
      work: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description"],
        properties: {
          title: stringSchema(256),
          description: stringSchema(16 * 1_024),
        },
      },
      capability: stringSchema(128, SAFE_TOKEN.source),
      dependsOn: {
        type: "array",
        maxItems: MAX_DEPENDENCIES,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["taskId", "revision"],
          properties: {
            taskId: stringSchema(192, SAFE_TASK_ID.source),
            revision: revisionSchema,
          },
        },
      },
      acceptanceContract: acceptanceContractSchema,
    }),
    orchestrationSchema("assign", {
      capability: stringSchema(128, SAFE_TOKEN.source),
    }),
    orchestrationSchema("accept_delivery", {
      submittedDeliveryRevision: revisionSchema,
    }),
    orchestrationSchema("return_delivery", {
      submittedDeliveryRevision: revisionSchema,
    }),
    orchestrationSchema("escalate", {
      question: stringSchema(4_096),
      choices: {
        type: "array",
        minItems: 1,
        maxItems: MAX_CHOICES,
        items: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(choiceProperties),
          properties: choiceProperties,
        },
      },
    }),
    orchestrationSchema("pause"),
    orchestrationSchema("pause", {
      waitForChildren: { type: "boolean", const: true },
    }),
    orchestrationSchema("resume"),
    orchestrationSchema("cancel"),
  ],
});

const evidenceProperties = {
  kind: {
    ...stringSchema(128, SAFE_TOKEN.source),
    not: { enum: RESERVED_CALLER_EVIDENCE_KINDS },
  },
  referenceId: stringSchema(512, SAFE_REFERENCE_ID.source),
  contentDigest: stringSchema(64, SHA256.source),
};
const submitDeliveryProperties = {
  schemaVersion: { type: "integer", const: 1 },
  type: { type: "string", const: "submit_delivery" },
  taskId: stringSchema(192, SAFE_TASK_ID.source),
  expectedTaskRevision: revisionSchema,
  expectedGraphRevision: graphRevisionSchema,
  contractRevision: revisionSchema,
  deliverableId: stringSchema(128, SAFE_TOKEN.source),
  summary: stringSchema(16 * 1_024),
  reason: stringSchema(4_096),
  evidence: {
    type: "array",
    minItems: 0,
    maxItems: MAX_CALLER_EVIDENCE,
    uniqueItems: true,
    items: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(evidenceProperties),
      properties: evidenceProperties,
    },
  },
  artifact: {
    oneOf: [
      { type: "null" },
      REQUIREMENT_SPEC_DRAFT_JSON_SCHEMA,
    ],
  },
};

export const SUBMIT_DELIVERY_INTENT_JSON_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: Object.keys(submitDeliveryProperties),
  properties: submitDeliveryProperties,
  oneOf: [
    {
      required: ["deliverableId", "artifact"],
      properties: {
        deliverableId: { const: "requirement-spec" },
        artifact: REQUIREMENT_SPEC_DRAFT_JSON_SCHEMA,
      },
    },
    {
      required: ["deliverableId", "artifact"],
      properties: {
        deliverableId: { not: { const: "requirement-spec" } },
        artifact: { type: "null" },
      },
    },
  ],
});
