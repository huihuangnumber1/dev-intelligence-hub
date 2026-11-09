import assert from "node:assert/strict";
import test from "node:test";
import { summarizeDashboardErrors } from "../public/status-error-summary.js";

test("four DingTalk token failures become one actionable profile-specific message", () => {
  const diagnostic = 'dws failed with exit code 5: { "error": { "message": "旧版登录态已无法由当前认证服务刷新；profile: \\"ding7430919261148c4f:1137300121374851\\": MCP token exchange failed: invalidParameter.authCode.notFound" } }';
  const summary = summarizeDashboardErrors(
    ["daily messages", "unread", "mentions", "todos"]
      .map((source) => `${source}: ${diagnostic}`),
  );
  assert.equal(summary.length, 1);
  assert.match(summary[0], /dws auth login --profile/);
  assert.match(summary[0], /ding7430919261148c4f:1137300121374851/);
  assert.doesNotMatch(summary[0], /exit code|MCP token exchange|daily messages/);
});

test("other diagnostics remain visible within a bounded banner", () => {
  const summary = summarizeDashboardErrors([
    `GitHub: ${"x".repeat(300)}`,
    "brain: unavailable",
    "report: failed",
    "extra: failed",
  ]);
  assert.equal(summary.length, 4);
  assert.ok(summary[0].length <= 180);
  assert.equal(summary[3], "另有 1 项异常");
});

test("DingTalk mention rate limits produce a short retry message without raw diagnostics", () => {
  const error = `mentions: dws failed with exit code 1: ${JSON.stringify({
    error: {
      category: "api",
      code: 1,
      reason: "business_error",
      retryable: true,
      server_error_code: "RATE_LIMIT_ERROR",
      trace_id: "private-trace-id",
      message: "business error: success=false",
    },
  })}`;
  const summary = summarizeDashboardErrors([error]);
  assert.deepEqual(summary, ["钉钉 @我消息查询被限流，本轮未更新；系统将在下次定时刷新时重试。"]);
  assert.doesNotMatch(summary.join(""), /trace|JSON|exit code|RATE_LIMIT_ERROR/u);
  assert.deepEqual(
    summarizeDashboardErrors([error, error.replace(/^mentions:/u, "todos:")]),
    ["钉钉 @我消息、待办查询被限流，本轮未更新；系统将在下次定时刷新时重试。"],
  );
});
