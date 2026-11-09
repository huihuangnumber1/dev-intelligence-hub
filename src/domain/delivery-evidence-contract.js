import { createHash } from "node:crypto";

import { normalizeWorkGraphAcceptanceContract } from "./work-graph-contract.js";

const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:/#-]{0,254}[A-Za-z0-9])?$/;
const SAFE_ROLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const SAFE_TOKEN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVIEW_EVIDENCE_KINDS = Object.freeze([
  "github-review",
  "review-report",
]);
const MODIFY_EVIDENCE_KINDS = Object.freeze(["change-package"]);
const VERIFY_EVIDENCE_KINDS = Object.freeze(["test-report"]);
const NO_EVIDENCE_KINDS = Object.freeze([]);
export const DELIVERY_EVIDENCE_ACTION_INCOMPATIBLE = "DELIVERY_EVIDENCE_ACTION_INCOMPATIBLE";

function invalid(message = "Delivery evidence target is invalid") {
  return new TypeError(message);
}

function exactObject(value, keys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function text(value, name, maximumBytes, pattern) {
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < 1) {
    throw invalid("contractRevision is invalid");
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function deliveryAcceptanceContractDigest(value) {
  const { recordedAt: _recordedAt, ...content } = exactObject(
    value,
    Object.hasOwn(value ?? {}, "recordedAt")
      ? ["revision", "acceptanceCriteria", "expectedDeliverables", "recordedAt"]
      : ["revision", "acceptanceCriteria", "expectedDeliverables"],
    "acceptanceContract",
  );
  const contract = normalizeWorkGraphAcceptanceContract(content);
  return createHash("sha256")
    .update(JSON.stringify(stableValue(contract)), "utf8")
    .digest("hex");
}

function normalizeDeliverables(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 1 ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalid("deliverables is invalid");
  }
  const deliverables = value.map((entry) => {
    const record = exactObject(entry, ["deliverableId", "kind"], "deliverable");
    return {
      deliverableId: text(
        record.deliverableId,
        "deliverableId",
        128,
        SAFE_TOKEN,
      ),
      kind: text(record.kind, "kind", 128, SAFE_TOKEN),
    };
  });
  const keys = deliverables.map(({ deliverableId }) => deliverableId);
  if (new Set(keys).size !== keys.length) {
    throw invalid("deliverables is invalid");
  }
  return deliverables.sort((left, right) =>
    left.deliverableId.localeCompare(right.deliverableId, "en")
  );
}

export function normalizeDeliveryEvidenceTarget(value) {
  const target = exactObject(
    value,
    [
      "schemaVersion",
      "taskId",
      "roleId",
      "contractRevision",
      "contractDigest",
      "deliverables",
    ],
    "evidenceTarget",
  );
  if (target.schemaVersion !== 1) throw invalid("schemaVersion is invalid");
  return Object.freeze({
    schemaVersion: 1,
    taskId: text(target.taskId, "taskId", 256, SAFE_ID),
    roleId: text(target.roleId, "roleId", 128, SAFE_ROLE_ID),
    contractRevision: revision(target.contractRevision),
    contractDigest: text(target.contractDigest, "contractDigest", 64, SHA256),
    deliverables: Object.freeze(normalizeDeliverables(target.deliverables)),
  });
}

export function createDeliveryEvidenceTarget({
  taskId,
  roleId,
  acceptanceContract,
  deliverableId,
} = {}) {
  const { recordedAt: _recordedAt, ...content } = acceptanceContract;
  const contract = normalizeWorkGraphAcceptanceContract(content);
  const selectedDeliverable = selectDeliverable(
    contract.expectedDeliverables,
    deliverableId,
  );
  return normalizeDeliveryEvidenceTarget({
    schemaVersion: 1,
    taskId,
    roleId,
    contractRevision: contract.revision,
    contractDigest: deliveryAcceptanceContractDigest(contract),
    deliverables: [selectedDeliverable],
  });
}

export function deliveryEvidenceKindsForProposal({ kind, operation } = {}) {
  if (kind === "github_review_proposal") return REVIEW_EVIDENCE_KINDS;
  if (kind !== "code_action_proposal") return NO_EVIDENCE_KINDS;
  if (operation === "modify") return MODIFY_EVIDENCE_KINDS;
  if (operation === "verify") return VERIFY_EVIDENCE_KINDS;
  return NO_EVIDENCE_KINDS;
}

export function createProposalDeliveryEvidenceTarget({
  taskId,
  roleId,
  acceptanceContract,
  proposal,
  deliverableId,
} = {}) {
  const { recordedAt: _recordedAt, ...content } = acceptanceContract;
  const contract = normalizeWorkGraphAcceptanceContract(content);
  const compatibleKinds = deliveryEvidenceKindsForProposal(proposal);
  const selectedDeliverable = selectCompatibleDeliverable(
    contract.expectedDeliverables,
    compatibleKinds,
    deliverableId,
  );
  return normalizeDeliveryEvidenceTarget({
    schemaVersion: 1,
    taskId,
    roleId,
    contractRevision: contract.revision,
    contractDigest: deliveryAcceptanceContractDigest(contract),
    deliverables: [selectedDeliverable],
  });
}

function selectDeliverable(expectedDeliverables, requestedId) {
  if (requestedId === undefined) {
    if (expectedDeliverables.length !== 1) {
      throw invalid("deliverableId is required for a multi-deliverable contract");
    }
    const [{ deliverableId, kind }] = expectedDeliverables;
    return { deliverableId, kind };
  }
  const normalizedId = text(requestedId, "deliverableId", 128, SAFE_TOKEN);
  const selected = expectedDeliverables.find(
    ({ deliverableId }) => deliverableId === normalizedId,
  );
  if (selected === undefined) {
    throw invalid("deliverableId is not present in the acceptance contract");
  }
  return { deliverableId: selected.deliverableId, kind: selected.kind };
}

function selectCompatibleDeliverable(
  expectedDeliverables,
  compatibleKinds,
  requestedId,
) {
  if (requestedId !== undefined) {
    const selected = selectDeliverable(expectedDeliverables, requestedId);
    if (!compatibleKinds.includes(selected.kind)) {
      throw invalid("deliverableId is incompatible with the proposal action");
    }
    return selected;
  }
  const compatible = expectedDeliverables.filter(({ kind }) =>
    compatibleKinds.includes(kind)
  );
  if (compatible.length === 0) {
    throw Object.assign(invalid("proposal action cannot produce an expected deliverable"), {
      code: DELIVERY_EVIDENCE_ACTION_INCOMPATIBLE,
    });
  }
  if (compatible.length > 1) {
    throw invalid("deliverableId is required for multiple compatible deliverables");
  }
  const [{ deliverableId, kind }] = compatible;
  return { deliverableId, kind };
}
