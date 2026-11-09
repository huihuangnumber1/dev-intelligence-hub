import { createHash } from "node:crypto";
import { normalizeOwnerWorkRequest } from "./owner-work-request.js";
import { isAutomaticReviewExecution } from "./automatic-review-policy.js";

const REVIEW_KINDS = new Set(["github.work-proposal-review", "github.pull-request-review"]);
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const PRODUCT = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function invalid(message = "Review 交接选择无效") {
  return Object.assign(new Error(message), { code: "INVALID_REVIEW_HANDOFF", statusCode: 400 });
}
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length || keys.some((key) => {
        const entry = Object.getOwnPropertyDescriptor(value, key);
        return !entry?.enumerable || !("value" in entry);
      })) throw invalid();
}
export function normalizeReviewHandoffSelection(value) {
  exact(value, ["workType", "responsiblePerson"]);
  if (!["development", "testing", "pull_request", "assignment"].includes(value.workType)) throw invalid();
  let responsiblePerson = null;
  if (value.responsiblePerson !== null) {
    exact(value.responsiblePerson, ["login", "product"]);
    const { login, product } = value.responsiblePerson;
    if (typeof login !== "string" || !LOGIN.test(login) || typeof product !== "string" || !PRODUCT.test(product)) throw invalid();
    responsiblePerson = { login, product };
  }
  if (value.workType === "testing" && !responsiblePerson) throw invalid();
  if (value.workType === "assignment" && responsiblePerson !== null) throw invalid();
  return { workType: value.workType, responsiblePerson };
}
export function reviewHandoffRequestId(item) {
  const hash = createHash("sha256").update(JSON.stringify(["review-handoff-v1", item.id, item.approvalBindingDigest, item.displayedPayloadDigest])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export function normalizeReviewHandoff(value, item = null) {
  exact(value, ["selection", "requestId", "acceptedRequestId", "status", "attempts", "diagnosticCode", "workItemId", "roleId", ...(Object.hasOwn(value, "assignedLogin") ? ["assignedLogin"] : []),
    ...(Object.hasOwn(value, "deliveryKind") ? ["deliveryKind"] : [])]);
  if (Object.hasOwn(value, "assignedLogin") && (value.status !== "completed" || !LOGIN.test(value.assignedLogin))) throw invalid();
  const selection = normalizeReviewHandoffSelection(value.selection);
  if (value.deliveryKind !== undefined && value.deliveryKind !== "assignment_only") throw invalid();
  const assignmentOnly = selection.workType === "assignment" || value.deliveryKind === "assignment_only";
  if (assignmentOnly && (!/^auto-review-v1-[a-f0-9]{48}$/.test(value.acceptedRequestId) ||
      (item && (item.kind !== "github.work-proposal-review" ||
        !(["REQUEST_CHANGES", "COMMENT"].includes(item.action?.reviewEvent) ||
          (item.action?.reviewEvent === "APPROVE" && selection.workType === "testing" && selection.responsiblePerson)))))) throw invalid();
  if (!UUID.test(value.requestId) || typeof value.acceptedRequestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/.test(value.acceptedRequestId) ||
      !["pending", "retrying", "completed", "stale"].includes(value.status) || !Number.isSafeInteger(value.attempts) || value.attempts < 0 ||
      (value.diagnosticCode !== null && (typeof value.diagnosticCode !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.diagnosticCode))) ||
      [value.workItemId, value.roleId].some((entry) => entry !== null && (typeof entry !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(entry)))) throw invalid();
  if (value.status === "completed"
    ? value.diagnosticCode !== null || (assignmentOnly
      ? value.workItemId !== null || value.roleId !== null || !LOGIN.test(value.assignedLogin || "")
      : !value.workItemId || !value.roleId)
    : value.workItemId !== null || value.roleId !== null) throw invalid();
  if (item && (!REVIEW_KINDS.has(item.kind) || item.action?.type !== "pull_request_review" || value.requestId !== reviewHandoffRequestId(item))) throw invalid();
  return { ...value, selection };
}
export function createReviewHandoff(item, request, policy) {
  if (!REVIEW_KINDS.has(item.kind) || item.action?.type !== "pull_request_review") throw invalid("只有 GitHub Review 可以绑定交接");
  const selection = normalizeReviewHandoffSelection(request.reviewHandoff);
  if (selection.workType === "assignment" && (!/^auto-review-v1-[a-f0-9]{48}$/.test(request.requestId) ||
      item.kind !== "github.work-proposal-review" || !["REQUEST_CHANGES", "COMMENT"].includes(item.action.reviewEvent))) throw invalid("只有自动 Review 修改意见或评论可以只交接作者分配");
  const person = selection.responsiblePerson;
  if (person && selection.workType === "development") {
    if (person.login.toLowerCase() !== item.actor.accountId.toLowerCase()) {
      throw invalid("开发交接负责人必须是本次批准绑定的账号");
    }
  } else if (person) {
    const field = selection.workType === "testing" ? "testingOwnersByProduct" : "reviewOwnersByProduct";
    if (!policy?.[field]?.[person.product]?.some((login) => login.toLowerCase() === person.login.toLowerCase())) throw invalid("负责人不在当前配置的交接名单中");
  }
  const result = { selection, requestId: reviewHandoffRequestId(item), acceptedRequestId: request.requestId, status: "pending", attempts: 0, diagnosticCode: null, workItemId: null, roleId: null };
  if (selection.workType === "assignment" || (selection.workType === "testing" && item.action.reviewEvent === "APPROVE" &&
      isAutomaticReviewExecution({ ...item, execution: { requestId: request.requestId } }))) result.deliveryKind = "assignment_only";
  reviewHandoffWorkRequest({ ...item, reviewHandoff: result });
  return result;
}
export function reviewHandoffWorkRequest(item) {
  const handoff = normalizeReviewHandoff(item.reviewHandoff, item);
  const match = /^([^#]+)#([1-9]\d*)$/.exec(item.target.resourceId);
  if (!match) throw invalid("Review 交接缺少明确的 PR 目标");
  const { workType, responsiblePerson } = handoff.selection;
  if (workType === "testing" && item.action.reviewEvent === "APPROVE" &&
      (handoff.deliveryKind === "assignment_only" || isAutomaticReviewExecution(item))) {
    return { schemaVersion: 1, kind: "review_testing_assignment", requestId: handoff.requestId,
      pullRequest: { repository: match[1], number: Number(match[2]) }, headRefOid: item.target.version,
      reviewEvent: "APPROVE", responsiblePerson };
  }
  if (workType === "assignment" || handoff.deliveryKind === "assignment_only" ||
      (isAutomaticReviewExecution(item) && ["REQUEST_CHANGES", "COMMENT"].includes(item.action.reviewEvent) && workType === "pull_request")) {
    return { schemaVersion: 1, kind: "review_author_assignment", requestId: handoff.requestId,
      pullRequest: { repository: match[1], number: Number(match[2]) }, headRefOid: item.target.version, reviewEvent: item.action.reviewEvent };
  }
  return normalizeOwnerWorkRequest({
    schemaVersion: responsiblePerson ? workType === "testing" ? 3 : 4 : 2,
    requestId: handoff.requestId,
    workType,
    priority: "high",
    title: `Review 后续 ${workType}：${match[1]} #${match[2]}`,
    description: `已确认完成 GitHub Review，继续处理 https://github.com/${match[1]}/pull/${match[2]}。\n确认：${item.id}\n批准时 Head：${item.target.version}\n请先核对最新 Head；不得将已批准 Review 视为对后续新提交的批准。`,
    acceptanceCriteria: ["核对 PR 的最新状态与 Head", "完成所选岗位的可验证交付并记录下一责任人"],
    pullRequest: { repository: match[1], number: Number(match[2]) },
    ...(responsiblePerson ? { responsiblePerson } : {}),
  });
}
