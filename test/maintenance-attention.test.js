import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { maintenanceAttentionCode } from "../src/domain/maintenance-attention.js";
import { maintenanceAttentionMarkup } from "../public/maintenance-attention.js";
import { brainFailureOwnerAttention } from "../src/services/brain-failure-policy.js";

test("changing attention display entries cannot change loop budgets code job recovery or historical approvals", async () => {
  const attentionUrl = new URL("../src/services/brain-failure-policy.js", import.meta.url).href;
  // Change presentation at the module boundary in a fresh process. Exercise the
  // real loop/worker matrices, including a display-only unknown failure.
  const hooks = `
    export async function load(url, context, nextLoad) {
      const loaded = await nextLoad(url, context);
      if (url !== ${JSON.stringify(attentionUrl)}) return loaded;
      const signature = 'export function brainFailureOwnerAttention(code) {';
      const original = String(loaded.source);
      if (!original.includes(signature)) throw new Error('Attention presentation boundary was not replaced');
      const source = original.replace(signature, 'function originalAttention(code) {');
      return { ...loaded, source: source + \`
        export function brainFailureOwnerAttention(code) {
          if (['STRUCTURED_PROVIDER_UNAVAILABLE', 'STRUCTURED_PROVIDER_PROCESS_FAILED',
            'STRUCTURED_PROVIDER_PROCESS_EXITED', 'STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED',
            'STRUCTURED_PROVIDER_CLEANUP_FAILED', 'STRUCTURED_PROVIDER_REAP_FAILED'].includes(code)) return null;
          if (code === 'UNKNOWN_RECOVERY_FAILURE') return {
            code, summary: 'Display-only failure', remediation: 'Display-only help', retryLabel: 'Retry'
          };
          return originalAttention(code);
        }
      \` };
    }`;
  const loader = `import { register } from 'node:module';
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)}, import.meta.url);`;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = await new Promise(resolve => execFile(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(loader)}`,
    "--test", "--test-concurrency=1", "--test-reporter=tap",
    "--test-name-pattern=infrastructure failures separate|real native provider|known infrastructure failures retry|proactive-only task-brain|unknown recovery metadata|session and process maintenance questions|system maintenance questions retry",
    "test/proactive-work-loop.test.js", "test/code-job-worker-service.test.js", "test/work-ledger-service.test.js",
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: environment, maxBuffer: 1024 * 1024 },
  (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.equal(result.error, null, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# tests [1-9][0-9]+\b/);
});

test("known maintenance attention keeps its existing repair guidance", () => {
  for (const [code, summary, remediation, retryLabel] of [
    ["STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", "岗位 CLI 会话进度未能安全归档",
      "这是系统会话保存或恢复故障，请先由维护人员修复；保留隔离目录中的会话历史，不要删除。修复前可选择“稍后再看”，重试只会重新排队，不会修复会话", "修复后重试"],
    ["STRUCTURED_PROVIDER_CLEANUP_FAILED", "岗位任务大脑的隔离运行环境未能安全清理",
      "确认受监督 CLI 进程已结束，并清理隔离运行环境", "已配置，重试"],
    ["STRUCTURED_PROVIDER_REAP_FAILED", "岗位任务大脑的受监督 CLI 进程未能安全结束",
      "确认受监督 CLI 进程已结束，并清理隔离运行环境", "已配置，重试"],
  ]) {
    assert.deepEqual(brainFailureOwnerAttention(code), { code, summary, remediation, retryLabel });
  }
});

test("only system retry requests for maintenance faults leave the business confirmation queue", () => {
  const item = { choices: [{ id: "configured-retry" }], context: [{ label: "判断依据", value: "已停止（STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED）" }] };
  assert.equal(maintenanceAttentionCode(item), "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED");
  assert.equal(maintenanceAttentionCode({ ...item, choices: [{ id: "accept" }] }), null);
  for (const code of ["ROLE_TASK_BRAIN_NOT_CONFIGURED", "BRAIN_CREDENTIAL_UNAVAILABLE", "STRUCTURED_PROVIDER_UNAVAILABLE"]) {
    assert.equal(maintenanceAttentionCode({ ...item, context: [{ label: "判断依据", value: `已停止（${code}）` }] }), null);
  }
});

test("maintenance view groups faults and escapes task content without offering bulk retry", () => {
  const items = ["developer", "tester"].map((roleId, index) => ({
    requestId: `attention-${index.toString().repeat(64)}`,
    maintenanceCode: "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
    producer: { roleId }, context: [{ label: "来源事件", value: "<img src=x onerror=alert(1)>" }],
  }));
  const html = maintenanceAttentionMarkup({ items, total: 2, loaded: true });
  assert.equal((html.match(/<details>/g) || []).length, 1);
  assert.equal((html.match(/data-maintenance-attention=/g) || []).length, 2);
  assert.match(html, /会话保存或恢复故障 · 2 项/);
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
  assert.match(html, /不会自动重试/);
});
