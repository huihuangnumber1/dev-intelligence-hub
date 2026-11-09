function attention(code, summary, remediation, retryLabel = "已配置，重试") {
  return Object.freeze({ code, summary, remediation, retryLabel });
}

const OWNER_ATTENTION_BY_CODE = new Map([
  ...["STRUCTURED_PROVIDER_PROCESS_FAILED", "STRUCTURED_PROVIDER_PROCESS_EXITED"].map(code => [
    code,
    attention(code, "岗位 CLI 执行中断", "任务将等待后重试。请根据执行记录检查 CLI 的退出阶段。", "自动重试中"),
  ]),
  [
    "STRUCTURED_PROVIDER_MODEL_CAPACITY",
    attention(
      "STRUCTURED_PROVIDER_MODEL_CAPACITY",
      "所选模型暂时满载",
      "系统将保留任务进度并稍后自动重试，无需确认或重新分配任务",
      "自动重试中",
    ),
  ],
  [
    "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
    attention(
      "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED",
      "岗位 CLI 会话进度未能安全归档",
      "这是系统会话保存或恢复故障，请先由维护人员修复；保留隔离目录中的会话历史，不要删除。修复前可选择“稍后再看”，重试只会重新排队，不会修复会话",
      "修复后重试",
    ),
  ],
  [
    "ROLE_TASK_BRAIN_NOT_CONFIGURED",
    attention(
      "ROLE_TASK_BRAIN_NOT_CONFIGURED",
      "岗位任务大脑尚未配置",
      "在配置中心为该岗位添加并激活 taskBrain",
    ),
  ],
  [
    "BRAIN_PROVIDER_NOT_CONFIGURED",
    attention(
      "BRAIN_PROVIDER_NOT_CONFIGURED",
      "岗位任务大脑 Provider 不可用",
      "在配置中心修正并激活 taskBrain 的 Provider",
    ),
  ],
  [
    "BRAIN_CREDENTIAL_UNAVAILABLE",
    attention(
      "BRAIN_CREDENTIAL_UNAVAILABLE",
      "岗位任务大脑凭据不可用",
      "提供配置中引用的凭据环境变量，并在需要时重启服务",
    ),
  ],
  [
    "REMOTE_DATA_NOT_AUTHORIZED",
    attention(
      "REMOTE_DATA_NOT_AUTHORIZED",
      "岗位任务大脑缺少远程数据授权",
      "在配置中心检查 taskBrain 的远程 requirements/code 数据授权并激活",
    ),
  ],
  [
    "STRUCTURED_PROVIDER_UNAVAILABLE",
    attention(
      "STRUCTURED_PROVIDER_UNAVAILABLE",
      "岗位任务大脑的结构化 Provider 不可用",
      "安装或修复该岗位配置的 CLI，并确认服务账户可执行",
    ),
  ],
  [
    "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
    attention(
      "STRUCTURED_PROVIDER_CREDENTIAL_UNAVAILABLE",
      "岗位任务大脑的结构化 Provider 凭据不可用",
      "为该岗位使用的 CLI 完成登录、认证或凭据配置",
    ),
  ],
  [
    "STRUCTURED_PROVIDER_CLEANUP_FAILED",
    attention(
      "STRUCTURED_PROVIDER_CLEANUP_FAILED",
      "岗位任务大脑的隔离运行环境未能安全清理",
      "确认受监督 CLI 进程已结束，并清理隔离运行环境",
    ),
  ],
  [
    "STRUCTURED_PROVIDER_REAP_FAILED",
    attention(
      "STRUCTURED_PROVIDER_REAP_FAILED",
      "岗位任务大脑的受监督 CLI 进程未能安全结束",
      "确认受监督 CLI 进程已结束，并清理隔离运行环境",
    ),
  ],
]);

export function brainFailureOwnerAttention(code) {
  if (typeof code !== "string") return null;
  return OWNER_ATTENTION_BY_CODE.get(code) ?? null;
}
