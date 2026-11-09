// Read-only compatibility for already persisted configured-retry requests.
// These historical signatures deliberately do not import mutable presentation.
const LEGACY_SUMMARIES = new Map([
  ["STRUCTURED_PROVIDER_PROCESS_FAILED", "岗位 CLI 执行中断"],
  ["STRUCTURED_PROVIDER_PROCESS_EXITED", "岗位 CLI 执行中断"],
  ["STRUCTURED_PROVIDER_MODEL_CAPACITY", "所选模型暂时满载"],
  ["STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED", "岗位 CLI 会话进度未能安全归档"],
  ["ROLE_TASK_BRAIN_NOT_CONFIGURED", "岗位任务大脑尚未配置"],
  ["BRAIN_PROVIDER_NOT_CONFIGURED", "岗位任务大脑 Provider 不可用"],
  ["BRAIN_CREDENTIAL_UNAVAILABLE", "岗位任务大脑凭据不可用"],
  ["REMOTE_DATA_NOT_AUTHORIZED", "岗位任务大脑缺少远程数据授权"],
  ["STRUCTURED_PROVIDER_UNAVAILABLE", "岗位任务大脑的结构化 Provider 不可用"],
  ["STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE", "岗位任务大脑的结构化 Provider 凭据不可用"],
  ["STRUCTURED_PROVIDER_CLEANUP_FAILED", "岗位任务大脑的隔离运行环境未能安全清理"],
  ["STRUCTURED_PROVIDER_REAP_FAILED", "岗位任务大脑的受监督 CLI 进程未能安全结束"],
]);

export function legacyBrainRecoveryCode(intent) {
  if (intent?.type !== "ask_user" || intent.choices?.length !== 1 ||
      intent.choices[0].id !== "configured-retry") return null;
  const code = /^真实任务不得回退到例行大脑；系统已安全停止（([A-Z_]+)）$/.exec(intent.reason)?.[1];
  const summary = LEGACY_SUMMARIES.get(code);
  return summary && intent.summary?.startsWith(`${summary}（`) && intent.summary.endsWith("）") ? code : null;
}

export function legacyMaintenanceAttentionCode(item) {
  if (!item.choices?.some(({ id }) => id === "configured-retry")) return null;
  const reason = item.context?.find(({ label }) => label === "判断依据")?.value;
  return /[（(](STRUCTURED_PROVIDER_[A-Z_]+)[）)]/.exec(reason || "")?.[1] ?? null;
}
