import { hasLaterIncomingAssignment } from "./automatic-review-policy.js";

const DAY = 86_400_000;

function assignedElsewhere(item) {
  return typeof item?.currentUser === 'string' && Boolean(item.currentUser) &&
    Array.isArray(item.assignees) && item.assignees.length > 0 &&
    !item.assignees.some(login => typeof login === 'string' && login.toLowerCase() === item.currentUser.toLowerCase());
}

export function isPersonalPullRequest(item) {
  if (typeof item?.currentUser !== 'string' || !item.currentUser) return false;
  if (assignedElsewhere(item)) return false;
  const account = item.currentUser.toLowerCase();
  return (typeof item.author === 'string' && item.author.toLowerCase() === account) ||
    (Array.isArray(item.assignees) && item.assignees.some(login => typeof login === 'string' && login.toLowerCase() === account));
}

export const ACTION_STATES = Object.freeze({
  ACTION_NOW: "action_now",
  WAITING_OTHER: "waiting_other",
  HISTORICAL: "historical",
  UNCERTAIN: "uncertain",
});

function assessment(actionState, nextActor, nextAction, reason) {
  return {
    actionState,
    nextActor,
    nextAction,
    actionReasons: [reason],
    requiresConfirmation: actionState === ACTION_STATES.UNCERTAIN,
  };
}

function ageInDays(updatedAt, now) {
  const updated = Date.parse(updatedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(updated) || !Number.isFinite(current)) return null;
  return Math.max(0, Math.floor((current - updated) / DAY));
}

function hasUnreviewedHead(item, reviewCommitOid) {
  return Boolean(
    item.headRefOid &&
      reviewCommitOid &&
      item.headRefOid !== reviewCommitOid,
  );
}

function assessAssignedReview(item, now) {
  if (item.isDraft) {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "author",
      "wait_ready_for_review",
      "等待作者将草稿标记为可审核",
    );
  }

  if (item.mergeStateStatus === "DIRTY") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "author",
      "wait_author_conflict",
      "等待作者解决合并冲突",
    );
  }

  if (item.ciStatus === "PENDING") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "ci",
      "wait_ci",
      "等待检查完成后再审核",
    );
  }

  if (item.myLatestPublishedReviewCommitOid === item.headRefOid &&
      hasLaterIncomingAssignment(item, item.currentUser, now)) {
    return assessment(ACTION_STATES.ACTION_NOW, "me", "rereview",
      "上轮审核后收到新的分配，需要完成本轮复审");
  }

  let reviewState = item.myReviewState;
  let reviewCommitOid = item.myReviewCommitOid;
  const publishedAt = Date.parse(item.myLatestPublishedReviewAt);
  const summarizedAt = Date.parse(item.myReviewAt);
  if (["APPROVED", "CHANGES_REQUESTED"].includes(item.myLatestPublishedReviewState) &&
      item.myLatestPublishedReviewCommitOid === item.headRefOid && Number.isFinite(publishedAt) &&
      (!Number.isFinite(summarizedAt) || publishedAt >= summarizedAt)) {
    reviewState = item.myLatestPublishedReviewState;
    reviewCommitOid = item.myLatestPublishedReviewCommitOid;
  }

  const decisiveOnHead = ["APPROVED", "CHANGES_REQUESTED"].includes(reviewState) &&
    reviewCommitOid === item.headRefOid;
  if (item.myLatestPublishedReviewState === "COMMENTED" &&
      item.myLatestPublishedReviewCommitOid === item.headRefOid && !decisiveOnHead) {
    return assessment(ACTION_STATES.ACTION_NOW, "me", "complete_review",
      "当前提交已复审评论，尚未给出最终审核结论");
  }

  if (!reviewState) {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "review",
      "等待你首次审核",
    );
  }

  if (hasUnreviewedHead(item, reviewCommitOid)) {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "rereview",
      "你审核后出现了新提交",
    );
  }

  if (!reviewCommitOid || !item.headRefOid) {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "缺少审核对应的提交信息",
    );
  }

  if (reviewState === "CHANGES_REQUESTED") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "author",
      "wait_author_changes",
      "等待作者按你的意见修改",
    );
  }

  if (reviewState === "APPROVED") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "merge_owner",
      "wait_merge",
      "你已审核通过，等待后续合并",
    );
  }

  if (reviewState === "COMMENTED") {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "complete_review",
      "你已评论但尚未给出审核结论",
    );
  }

  return assessment(
    ACTION_STATES.UNCERTAIN,
    "unknown",
    "confirm",
    `无法解释你的审核状态 ${reviewState}`,
  );
}

function assessAuthoredPullRequest(item) {
  if (item.mergeStateStatus === "DIRTY") {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "resolve_conflict",
      item.reviewFeedbackCount > 0 || item.reviewDecision === "CHANGES_REQUESTED"
        ? "先解决合并冲突，再核验审核意见" : "需要先解决合并冲突",
    );
  }
  const progress = item.reviewRepairProgress;
  const publishedRepair = item.reviewFeedbackAvailable === true && progress?.status === "published" &&
    progress.headRefOid === item.headRefOid && progress.feedbackDigest === item.reviewFeedbackDigest &&
    typeof progress.feedbackDigest === "string" && /^[a-f0-9]{64}$/.test(progress.feedbackDigest) &&
    Array.isArray(progress.commitOids) && progress.commitOids.length > 0 &&
    progress.commitOids.every(oid => typeof oid === "string" && /^[a-f0-9]{40,64}$/.test(oid));
  if (item.reviewFeedbackAvailable === true && Number.isSafeInteger(item.reviewFeedbackCount) && item.reviewFeedbackCount > 0 && !publishedRepair) {
    const historicalOnly = item.reviewPendingThreadCount === 0 && item.reviewChangeRequestCount > 0 &&
      item.outstandingChangeRequestCommitOids?.length > 0 &&
      item.outstandingChangeRequestCommitOids.every(oid => oid !== item.headRefOid);
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "address_review",
      historicalOnly ? "有历史修改要求，需核验当前代码后安排复审" :
        item.reviewPendingThreadCount > 0 ? "仍有未关闭的审核讨论，需核验当前代码中的处理情况" :
          "有审核修改要求，需核验当前代码中的处理情况",
    );
  }

  if (["FAILURE", "ERROR"].includes(item.ciStatus)) {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "fix_ci",
      "检查失败，需修复或复核失败原因",
    );
  }

  if (item.isDraft) {
    return assessment(
      ACTION_STATES.ACTION_NOW,
      "me",
      "continue_draft",
      "草稿仍需继续推进或关闭",
    );
  }

  if (publishedRepair) {
    return assessment(ACTION_STATES.WAITING_OTHER, "reviewer", "wait_review",
      `修复已发布，等待当前提交复审${item.reviewPendingThreadCount > 0 ? "（仍有讨论未关闭）" : ""}`);
  }

  if (item.reviewDecision === "CHANGES_REQUESTED") {
    if (item.reviewFeedbackAvailable === false) {
      return assessment(
        ACTION_STATES.UNCERTAIN,
        "unknown",
        "confirm",
        "审核意见明细未能完整读取，不能自动判断修复范围",
      );
    }
    const outstandingChangeRequests =
      item.outstandingChangeRequestCommitOids || [];
    if (outstandingChangeRequests.length > 0) {
      return assessment(
        ACTION_STATES.ACTION_NOW,
        "me",
        "address_review",
        "审核意见尚未处理",
      );
    }
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "缺少修改意见对应的提交信息",
    );
  }

  if (item.reviewDecision === "APPROVED") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "merge_owner",
      "wait_merge",
      "审核已通过，等待合并",
    );
  }

  if (item.ciStatus === "PENDING") {
    return assessment(
      ACTION_STATES.WAITING_OTHER,
      "ci",
      "wait_ci",
      "等待检查完成",
    );
  }

  return assessment(
    ACTION_STATES.WAITING_OTHER,
    "reviewer",
    "wait_review",
    "等待他人审核或反馈",
  );
}

export function assessPullRequestResponsibility(
  item,
  {
    now = new Date().toISOString(),
    historicalAfterDays = 30,
  } = {},
) {
  if (item.state && item.state !== "open") {
    return assessment(
      ACTION_STATES.HISTORICAL,
      "none",
      "closed",
      `PR 已${item.state}`,
    );
  }

  if (assignedElsewhere(item)) {
    return assessment(ACTION_STATES.WAITING_OTHER, 'assignee', 'wait_assignee',
      '当前已分配给他人，等待当前负责人推进');
  }

  const inactiveDays = ageInDays(item.updatedAt, now);
  if (inactiveDays === null) {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "GitHub 未返回有效更新时间",
    );
  }
  if (inactiveDays >= historicalAfterDays) {
    return {
      ...assessment(
        ACTION_STATES.HISTORICAL,
        "unknown",
        "cleanup",
        `${inactiveDays} 天未活动，进入历史清理`,
      ),
      inactiveDays,
    };
  }

  if (item.reviewFactsAvailable !== true) {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "GitHub 审核事实未能完整读取",
    );
  }

  if (!item.headRefOid) {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "GitHub 未返回当前提交标识",
    );
  }

  if (item.ciStatus === "UNKNOWN") {
    return assessment(
      ACTION_STATES.UNCERTAIN,
      "unknown",
      "confirm",
      "GitHub 返回了无法识别的检查状态",
    );
  }

  if (item.relation === "review_requested") {
    const result = assessAssignedReview(item, now);
    if (result.actionState === ACTION_STATES.ACTION_NOW && ["FAILURE", "ERROR"].includes(item.ciStatus)) {
      result.actionReasons.push("检查失败，需在 Review 中核查原因并提醒作者");
    }
    return result;
  }

  if (item.relation === "authored") {
    return assessAuthoredPullRequest(item);
  }

  return assessment(
    ACTION_STATES.UNCERTAIN,
    "unknown",
    "confirm",
    "无法确定你在这个 PR 中的责任角色",
  );
}
