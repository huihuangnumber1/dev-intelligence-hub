const DINGTALK_LOGIN_FAILURE =
  /旧版登录态已无法由当前认证服务刷新|invalidParameter\.authCode\.notFound/u;
const PROFILE = /profile:\s*\\*"([A-Za-z0-9._-]+:[A-Za-z0-9._-]+)\\*"/u;
const DINGTALK_READ_FAILURE = /^(daily messages|unread|mentions|todos):\s*dws failed with exit code\b/iu;
const DINGTALK_RATE_LIMIT = /"server_error_code"\s*:\s*"RATE_LIMIT_ERROR"/u;
const DINGTALK_SOURCE_LABELS = {
  "daily messages": "今日消息",
  unread: "未读会话",
  mentions: "@我消息",
  todos: "待办",
};

export function summarizeDashboardErrors(errors) {
  const messages = [];
  let dingtalkLoginFailure = false;
  const rateLimitedSources = new Set();
  for (const error of errors) {
    if (DINGTALK_LOGIN_FAILURE.test(error)) {
      if (dingtalkLoginFailure) continue;
      dingtalkLoginFailure = true;
      const profile = error.match(PROFILE)?.[1];
      messages.push(profile
        ? `钉钉授权已失效。请在本机运行 dws auth login --profile "${profile}" 重新授权；钉钉消息和待办暂未刷新。`
        : "钉钉授权已失效。请在本机运行 dws auth login 重新授权；钉钉消息和待办暂未刷新。");
      continue;
    }
    const dingtalkSource = String(error).match(DINGTALK_READ_FAILURE)?.[1]?.toLowerCase();
    if (dingtalkSource) {
      const label = DINGTALK_SOURCE_LABELS[dingtalkSource];
      if (DINGTALK_RATE_LIMIT.test(error)) rateLimitedSources.add(label);
      else messages.push(`钉钉 ${label}查询失败，本轮未更新；系统将在下次定时刷新时重试。`);
      continue;
    }
    const compact = String(error).replace(/\s+/gu, " ").trim();
    if (compact) messages.push(compact.length > 180
      ? `${compact.slice(0, 177)}…`
      : compact);
  }
  if (rateLimitedSources.size) {
    messages.unshift(`钉钉 ${[...rateLimitedSources].join("、")}查询被限流，本轮未更新；系统将在下次定时刷新时重试。`);
  }
  const visible = messages.slice(0, 3);
  if (messages.length > visible.length) {
    visible.push(`另有 ${messages.length - visible.length} 项异常`);
  }
  return visible;
}
