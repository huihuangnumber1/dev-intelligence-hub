const DEFAULT_TESTING_OWNERS = Object.freeze({
  qt: Object.freeze(["qt-tester-primary", "qt-tester-secondary"]),
  bs: Object.freeze(["bs-tester"]),
});
const DEFAULT_REVIEW_OWNERS = Object.freeze({
  qt: Object.freeze(["qt-reviewer"]),
  bs: Object.freeze(["bs-reviewer"]),
});

const PRODUCT_LABELS = Object.freeze({ qt: "Qt 桌面版", bs: "B/S 版本" });
const GITHUB_LOGIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

// History is read-only. Preserve only validated fields from the API projection.
export function normalizeReviewHandoffHistory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const selection = value.selection;
  if (!selection || !["development", "testing", "pull_request"].includes(selection.workType)) return null;
  const person = selection.responsiblePerson;
  if (person !== null && (!person || typeof person !== "object" ||
      typeof person.login !== "string" || !GITHUB_LOGIN.test(person.login) ||
      typeof person.product !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(person.product))) return null;
  if (selection.workType === "testing" && person === null) return null;
  if (!["pending", "retrying", "completed", "stale"].includes(value.status) ||
      !Number.isSafeInteger(value.attempts) || value.attempts < 0 ||
      typeof value.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.requestId) ||
      typeof value.acceptedRequestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/.test(value.acceptedRequestId)) return null;
  if (value.diagnosticCode !== null && (typeof value.diagnosticCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.diagnosticCode))) return null;
  if (value.status === "completed") {
    if (value.diagnosticCode !== null || [value.workItemId, value.roleId].some((id) =>
      typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id))) return null;
  } else if (value.workItemId !== null || value.roleId !== null) return null;
  if (value.assignedLogin !== undefined && (value.status !== "completed" || !GITHUB_LOGIN.test(value.assignedLogin))) return null;
  return {
    selection: { workType: selection.workType, responsiblePerson: person === null ? null : { login: person.login, product: person.product } },
    requestId: value.requestId, acceptedRequestId: value.acceptedRequestId,
    status: value.status, attempts: value.attempts, diagnosticCode: value.diagnosticCode,
    workItemId: value.workItemId, roleId: value.roleId,
    ...(value.assignedLogin ? { assignedLogin: value.assignedLogin } : {}),
  };
}

function configuredOwners(configuration, field) {
  const value = configuration?.workCoordination?.policy
    ?.[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [product, owners] of Object.entries(value)) {
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(product)) continue;
    if (!Array.isArray(owners)) continue;
    const valid = [...new Set(owners.filter(
      (login) => typeof login === "string" && GITHUB_LOGIN.test(login),
    ))];
    if (valid.length) result[product] = valid;
  }
  return Object.keys(result).length ? result : null;
}

function ownerRouting(configuration, field, fallback) {
  const ownersByProduct = configuredOwners(configuration, field) || fallback;
  const preferred = ["qt", "bs"];
  const products = Object.keys(ownersByProduct).sort((left, right) => {
    const leftIndex = preferred.indexOf(left);
    const rightIndex = preferred.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex < 0 ? preferred.length : leftIndex) -
        (rightIndex < 0 ? preferred.length : rightIndex);
    }
    return left.localeCompare(right);
  });
  return Object.freeze({
    ownersByProduct,
    products,
    productLabel(product) {
      return PRODUCT_LABELS[product] || product.toUpperCase();
    },
    ownerLabel(login) {
      return `@${login}`;
    },
  });
}

export function testingOwnerRouting(configuration) {
  return ownerRouting(
    configuration,
    "testingOwnersByProduct",
    DEFAULT_TESTING_OWNERS,
  );
}

export function reviewerOwnerRouting(configuration) {
  return ownerRouting(
    configuration,
    "reviewOwnersByProduct",
    DEFAULT_REVIEW_OWNERS,
  );
}

export function inferTestingProduct(value, availableProducts = ["qt", "bs"]) {
  const text = String(value || "");
  if (
    availableProducts.includes("bs") &&
    /(?:\bB\s*\/\s*S\b|\bBS\s*(?:版|架构|前端|后端)|\bweb\b|网页端|浏览器端)/iu.test(text)
  ) {
    return "bs";
  }
  if (availableProducts.includes("qt") && /\bQt\b|桌面版|客户端/iu.test(text)) {
    return "qt";
  }
  return availableProducts.includes("qt") ? "qt" : availableProducts[0] || "";
}

const SELF_FIX_ACTIONS = new Set([
  "address_review",
  "fix_ci",
  "resolve_conflict",
  "continue_draft",
]);

const LIFECYCLE_STAGE_LABELS = Object.freeze({
  self_fix: "自己修复",
  external_review: "交给其他 Reviewer",
  testing: "交给测试",
  awaiting_author_fix: "等待作者修复",
  pr_follow_up: "PR 工程师继续推进",
  internal_review: "我方 Review",
  needs_triage: "待核对",
});

export function prLifecycleStageLabel(stage) {
  return LIFECYCLE_STAGE_LABELS[stage] || stage || "待核对";
}

function lifecycleRoute(
  ownership,
  stage,
  workType,
  responsibleKind,
  summary,
) {
  return Object.freeze({
    ownership,
    stage,
    workType,
    responsibleKind,
    summary,
  });
}

export function prReviewLifecycleRoute(item, reviewEvent) {
  const ownership = item?.relation === "authored"
    ? "self"
    : item?.relation === "review_requested"
      ? "other"
      : "unknown";

  if (
    ownership === "self" &&
    (reviewEvent === "REQUEST_CHANGES" || SELF_FIX_ACTIONS.has(item?.nextAction))
  ) {
    return lifecycleRoute(
      "self",
      "self_fix",
      "development",
      "self",
      "内部 Review 未通过，交回自己的开发任务；修复、测试并推送新 Head 后重新 Review。",
    );
  }
  if (ownership === "self" && reviewEvent === "APPROVE") {
    return lifecycleRoute(
      "self",
      "external_review",
      "pull_request",
      "external_reviewer",
      "内部 Review 通过，交给其他 Reviewer；对方提出问题时再回到自己的修复闭环。",
    );
  }
  if (ownership === "other" && reviewEvent === "APPROVE") {
    return lifecycleRoute(
      "other",
      "testing",
      "testing",
      "tester",
      "Review 通过，交给测试负责人验证；测试结论再进入合并门禁。",
    );
  }
  if (ownership === "other" && reviewEvent === "REQUEST_CHANGES") {
    return lifecycleRoute(
      "other",
      "awaiting_author_fix",
      "pull_request",
      "pr_engineer",
      "Review 未通过，等待 PR 作者修复；出现新 Head 后由 PR 工程师复审。",
    );
  }
  return lifecycleRoute(
    ownership,
    "pr_follow_up",
    "pull_request",
    "pr_engineer",
    ownership === "self"
      ? "继续跟进自己的 PR；达到可外部审核状态后交给其他 Reviewer。"
      : "由 PR 工程师跟进最新 Head、作者回复和后续 Review。",
  );
}

export function prLifecycleStatus(item) {
  if (item?.relation === "authored") {
    if (SELF_FIX_ACTIONS.has(item.nextAction)) {
      return Object.freeze({
        ownership: "self",
        stage: "self_fix",
        title: "自己的 PR · 修复闭环",
        nextOwner: "开发工程师（自己）",
        nextStep: "处理外部 Review 意见，测试并推送新 Head；随后重新进入 Review。",
      });
    }
    if (
      item.reviewDecision === "APPROVED" &&
      item.nextAction === "wait_merge"
    ) {
      return Object.freeze({
        ownership: "self",
        stage: "testing",
        title: "自己的 PR · 外部 Review 已通过",
        nextOwner: "测试工程师",
        nextStep: "执行版本对应的验证；通过后再进入合并门禁。",
      });
    }
    return Object.freeze({
      ownership: "self",
      stage: "external_review",
      title: "自己的 PR · 等待其他 Reviewer",
      nextOwner: "外部 Reviewer",
      nextStep: "通过则交测试；提出问题则回到自己的开发修复闭环。",
    });
  }
  if (item?.relation === "review_requested") {
    if (
      item.myReviewState === "CHANGES_REQUESTED" &&
      item.nextAction === "wait_author_changes"
    ) {
      return Object.freeze({
        ownership: "other",
        stage: "awaiting_author_fix",
        title: "别人的 PR · 等待作者修复",
        nextOwner: "PR 作者",
        nextStep: "作者推送新 Head 后，PR 工程师自动重新 Review。",
      });
    }
    return Object.freeze({
      ownership: "other",
      stage: "internal_review",
      title: "别人的 PR · 由我方 Review",
      nextOwner: "PR 工程师",
      nextStep: "通过则交测试；不通过则阻塞作者并等待新 Head 复审。",
    });
  }
  return Object.freeze({
    ownership: "unknown",
    stage: "needs_triage",
    title: "PR 所有权待核对",
    nextOwner: "PR 工程师",
    nextStep: "先核对作者和当前 Review 状态，再决定交测试、开发或外部 Reviewer。",
  });
}
