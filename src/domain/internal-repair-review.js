import { createHash } from "node:crypto";

const FIELDS = ["kind", "headRefOid", "feedbackDigest", "publicationConfirmationId", "controlledCommitEvidenceId"];
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const reference = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

export function normalizeInternalReviewMetadata(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== FIELDS.length ||
      !FIELDS.every((field) => Object.getOwnPropertyDescriptor(value, field)?.enumerable &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, field), "value")) ||
      !["own_pr_repair", "own_pr_ci_repair"].includes(value.kind) || typeof value.headRefOid !== "string" || !OID.test(value.headRefOid) ||
      typeof value.feedbackDigest !== "string" || !DIGEST.test(value.feedbackDigest) ||
      !reference(value.publicationConfirmationId) || !reference(value.controlledCommitEvidenceId)) {
    throw Object.assign(new Error("内部修复复审来源绑定无效"), { code: "INTERNAL_REVIEW_METADATA_INVALID" });
  }
  return Object.freeze(Object.fromEntries(FIELDS.map((field) => [field, value[field]])));
}

export function internalReviewEvidence(value) {
  const metadata = normalizeInternalReviewMetadata(value);
  return [`head:${metadata.headRefOid}`, `controlled-commit:${metadata.controlledCommitEvidenceId}`,
    `publication:${metadata.publicationConfirmationId}`];
}

export function internalRepairReviewRequestId({ repository, number, ...metadata }) {
  const normalized = normalizeInternalReviewMetadata(metadata);
  const hash = createHash("sha256").update(JSON.stringify(["internal-repair-review/v1", repository, number, normalized])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}


// Only the host-issued repair review event may carry its owned PR back into development.
export function isInternalRepairReviewEvent(event) {
  if (event?.eventType !== "pull_request.internal_review_requested" || event.source?.provider !== "internal-review-repair") return false;
  try { return normalizeInternalReviewMetadata(event.payload.internalReview).headRefOid === event.payload.headRefOid; }
  catch { return false; }
}

export function isInternalCiRepairReviewEvent(event) {
  return isInternalRepairReviewEvent(event) && event.payload.internalReview.kind === "own_pr_ci_repair";
}
