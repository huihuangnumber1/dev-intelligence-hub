export function internalAttentionDisplay(item) {
  const choices = item.choices || [];
  const sessionRecoveryFailed = item.maintenanceCode === "STRUCTURED_PROVIDER_SESSION_RECOVERY_FAILED" &&
    choices.some((choice) => choice.id === "configured-retry");
  if (!sessionRecoveryFailed) return { question: item.question, choices };
  return {
    question: "系统暂时无法保存或恢复这项任务的会话，需要维护人员修复。你无需补充模型配置；修复前可选择“稍后再看”。保留原会话历史，不要删除。",
    choices: choices.map((choice) => choice.id === "configured-retry" ? {
      ...choice,
      label: "修复后重试",
      description: "仅将原任务重新排队，不会自动修复会话。",
    } : choice),
  };
}
