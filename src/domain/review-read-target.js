import { types } from "node:util";
import { normalizePullRequestGitTarget } from "./git-tool-contract.js";
import { normalizeRepairFeedbackDescriptor } from "./original-repair-feedback.js";

export function normalizeReviewReadTarget(value) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("reviewTarget is invalid");
  }
  const keys = Reflect.ownKeys(value);
  const hasFeedback = keys.includes("repairFeedback");
  const hasSnapshot = keys.includes("feedbackSnapshot");
  if (keys.length !== 2 + Number(hasFeedback) + Number(hasSnapshot) || !keys.includes("gitTarget") || !keys.includes("pullRequestNumber")) {
    throw new TypeError("reviewTarget is invalid");
  }
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !("value" in field)) throw new TypeError("reviewTarget is invalid");
  }
  if (!Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber < 1) {
    throw new TypeError("reviewTarget is invalid");
  }
  const feedback = hasFeedback ? normalizeRepairFeedbackDescriptor(value.repairFeedback) : null;
  if (feedback && feedback.reviewHeadRefOid !== value.gitTarget?.headRefOid) throw new TypeError("reviewTarget feedback Head is invalid");
  let snapshot = null;
  if (hasSnapshot) {
    const valueSnapshot = value.feedbackSnapshot;
    if (!valueSnapshot || types.isProxy(valueSnapshot) || Object.getPrototypeOf(valueSnapshot) !== Object.prototype ||
        Reflect.ownKeys(valueSnapshot).length !== 2 || !["taskId", "materialDigest"].every(key => {
          const field = Object.getOwnPropertyDescriptor(valueSnapshot, key);
          return field?.enumerable && Object.hasOwn(field, "value");
        }) || typeof valueSnapshot.taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,191}$/.test(valueSnapshot.taskId) ||
        typeof valueSnapshot.materialDigest !== "string" || !/^[a-f0-9]{64}$/.test(valueSnapshot.materialDigest)) throw new TypeError("reviewTarget feedback snapshot is invalid");
    snapshot = Object.freeze({ taskId: valueSnapshot.taskId, materialDigest: valueSnapshot.materialDigest });
  }
  return Object.freeze({
    pullRequestNumber: value.pullRequestNumber,
    gitTarget: Object.freeze(normalizePullRequestGitTarget(value.gitTarget)),
    ...(feedback === null ? {} : { repairFeedback: feedback }),
    ...(snapshot === null ? {} : { feedbackSnapshot: snapshot }),
  });
}
