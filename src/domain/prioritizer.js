const DAY = 86_400_000;
export const DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS = 14;

function ageInDays(item, now) {
  const updatedAt = Date.parse(item.updatedAt || item.createdAt || now);
  return Math.max(0, Math.floor((Date.parse(now) - updatedAt) / DAY));
}

const PR_ACTION_SCORES = Object.freeze({
  review: 100,
  rereview: 100,
  complete_review: 100,
  address_review: 95,
  fix_ci: 92,
  resolve_conflict: 86,
  continue_draft: 75,
});

function scorePullRequestAction(item) {
  const actionReasons = item.actionReasons || [];

  if (item.actionState === "historical") {
    return { score: 5, reasons: actionReasons };
  }
  if (item.actionState === "waiting_other") {
    return { score: 35, reasons: actionReasons };
  }
  if (item.actionState === "uncertain") {
    return {
      score: 80,
      reasons: ["需要你确认责任归属", ...actionReasons],
    };
  }
  if (item.actionState === "action_now") {
    return {
      score: PR_ACTION_SCORES[item.nextAction] ?? 85,
      reasons: actionReasons.length ? actionReasons : ["现在轮到你处理"],
    };
  }
  return null;
}

function issueWindowDays(options) {
  return Number.isSafeInteger(options?.issueActiveWindowDays) &&
      options.issueActiveWindowDays > 0
    ? options.issueActiveWindowDays
    : DEFAULT_ISSUE_ACTIVE_WINDOW_DAYS;
}

export function scoreItem(
  item,
  now = new Date().toISOString(),
  options = {},
) {
  if (item.kind === "pull_request") {
    const actionScore = scorePullRequestAction(item);
    if (actionScore) {
      return {
        ...actionScore,
        reasons: [...new Set(actionScore.reasons)],
      };
    }
  }

  let score = 20;
  const reasons = [];

  if (item.kind === "pull_request" && item.relation === "review_requested") {
    score = 100;
    reasons.push("等待你审核");
  } else if (item.kind === "issue" && item.relation === "assigned") {
    score = 55;
    reasons.push("已分配给你");
  } else if (item.kind === "todo") {
    score = 75;
    reasons.push("钉钉待办");
  } else if (item.kind === "mention") {
    score = 82;
    reasons.push("钉钉 @我");
  } else if (item.kind === "announcement") {
    score = 88;
    reasons.push("今日公告/重要通知");
  } else if (item.kind === "message") {
    score = 78;
    reasons.push("今日重要消息");
  } else if (item.kind === "mail") {
    score = ["mentioned", "assigned", "authored", "review_requested"].includes(item.relation) ? 82 : 76;
    reasons.push(item.relation === "mentioned" ? "邮件明确 @你" :
      item.relation === "assigned" ? "邮件关联分配给你的工作" : "与你相关的重要邮件");
  } else if (item.kind === "pull_request" && item.relation === "authored") {
    score = 55;
    reasons.push("需要你修改或推进");
  }

  const staleDays = ageInDays(item, now);
  if (
    item.kind === "issue" &&
    item.relation === "assigned" &&
    staleDays >= issueWindowDays(options)
  ) {
    const days = issueWindowDays(options);
    return { score: 15, reasons: [`超过 ${days} 天，稍后处理`] };
  }

  if (item.reviewDecision === "CHANGES_REQUESTED") {
    score = Math.max(score, 95);
    reasons.unshift("审核要求修改");
  }
  if (item.ciStatus === "FAILURE" || item.ciStatus === "ERROR") {
    score = Math.max(score, 92);
    reasons.unshift("检查失败");
  }
  if (item.mergeStateStatus === "DIRTY") {
    score = Math.max(score, 86);
    reasons.unshift("存在合并冲突");
  }
  const labels = (item.labels || []).map((label) => label.toLowerCase());
  if (
    labels.some((label) =>
      ["urgent", "blocker", "priority: high", "p0", "p1"].includes(label),
    )
  ) {
    score = Math.max(score, 90);
    reasons.unshift("高优先级标签");
  }
  if (item.dueAt) {
    const daysUntilDue = Math.ceil(
      (Date.parse(item.dueAt) - Date.parse(now)) / DAY,
    );
    if (daysUntilDue < 0) {
      score = Math.max(score, 96);
      reasons.unshift("已经逾期");
    } else if (daysUntilDue <= 2) {
      score = Math.max(score, 88);
      reasons.unshift("即将到期");
    }
  }

  if (staleDays >= 5 && item.state !== "closed" && item.kind !== "issue") {
    score = Math.max(score, 65);
    reasons.push(`${staleDays} 天未更新`);
  }

  return { score, reasons: [...new Set(reasons)] };
}

export function prioritize(
  items,
  now = new Date().toISOString(),
  options = {},
) {
  return items
    .map((item) => ({ ...item, ...scoreItem(item, now, options) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0),
    );
}
