import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  renderBrainProviderStatus,
} from "../public/brain-provider-status-view.js";

const root = path.resolve(import.meta.dirname, "..");

function status(state) {
  return {
    schemaVersion: 1,
    state,
    cliAvailable: state !== "cli_unavailable",
    fileLoginAvailable: state === "available",
  };
}

test("Codex login status renderer covers every sanitized state", () => {
  const expectations = new Map([
    ["available", ["能力可用", "CLI 已安装且受支持", "文件式登录可安全代理"]],
    ["file_login_unavailable", ["登录不可用", "同一 Windows 用户", "codex login"]],
    ["unsafe_source", ["登录源不安全", "文件所有者、ACL 或链接"]],
    ["broker_blocked", ["凭据代理已封闭", "重启 Development Intelligence Hub"]],
    ["cli_unavailable", ["CLI 不可用", "安装项目支持的 Codex CLI"]],
  ]);

  for (const [state, visibleText] of expectations) {
    const markup = renderBrainProviderStatus({ state: status(state) });
    assert.match(markup, /Codex CLI 大脑能力/u, state);
    for (const text of visibleText) assert.ok(markup.includes(text), `${state}: ${text}`);
  }
});

test("Codex login status renderer handles loading, error, and pending restart", () => {
  const loading = renderBrainProviderStatus({ loading: true });
  assert.match(loading, /正在检查/u);
  assert.match(loading, /role="status"/u);

  const error = renderBrainProviderStatus({ error: "<script>failure</script>" });
  assert.doesNotMatch(error, /<script>/u);
  assert.match(error, /&lt;script&gt;/u);
  assert.match(error, /重新检查/u);

  const pending = renderBrainProviderStatus({
    state: status("available"),
    pendingRestart: true,
  });
  assert.match(pending, /已保存，重启后生效/u);
});

test("native readiness explains the active login route without claiming task progress", () => {
  const ready = renderBrainProviderStatus({
    state: { ...status("available"), credentialMode: "codex-native-login" },
  });
  assert.match(ready, /原生登录可用/u);
  assert.match(ready, /会话目录/u);
  assert.match(ready, /不代表任务已经开始/u);
  const blocked = renderBrainProviderStatus({
    state: { ...status("broker_blocked"), credentialMode: "codex-native-login" },
  });
  assert.match(blocked, /执行状态待核验/u);
  assert.doesNotMatch(blocked, /文件所有者|文件式登录可安全代理/u);
});

test("Codex login status renderer ignores private and unknown status fields", () => {
  const privateMarkers = [
    "owner@example.invalid",
    "token-private-marker",
    "digest-private-marker",
    "timestamp-private-marker",
    "C:\\private\\source\\auth.json",
    "C:\\private\\mirror",
  ];
  const value = {
    ...status("file_login_unavailable"),
    account: privateMarkers[0],
    token: privateMarkers[1],
    digest: privateMarkers[2],
    timestamp: privateMarkers[3],
    sourcePath: privateMarkers[4],
    mirrorPath: privateMarkers[5],
  };
  const markup = renderBrainProviderStatus({ state: value });

  for (const marker of privateMarkers) assert.equal(markup.includes(marker), false);
  assert.doesNotMatch(
    markup,
    /上传|下载|查看凭据|data-command|name="command"/u,
  );

  const unknown = renderBrainProviderStatus({
    state: { ...status("available"), state: "__proto__" },
  });
  assert.match(unknown, /无法识别/u);
});

test("configuration view loads and renders broker status independently", async () => {
  const [app, styles] = await Promise.all([
    readFile(path.join(root, "public", "app.js"), "utf8"),
    readFile(path.join(root, "public", "styles.css"), "utf8"),
  ]);

  assert.match(app, /from "\.\/brain-provider-status-view\.js"/u);
  assert.match(app, /fetch\("\/api\/brain-providers\/status"/u);
  assert.match(
    app,
    /fetch\("\/api\/brain-providers\/status",\s*\{[\s\S]*?cache: "no-store"[\s\S]*?signal: controller\.signal/u,
  );
  assert.match(app, /renderBrainProviderStatus\(/u);
  assert.match(app, /configurationRequiresRestart\(\)/u);
  assert.match(styles, /\.brain-provider-status-card/u);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*\.brain-provider-status-facts/u);
});
