const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const STRUCTURE_OPERATIONS = Object.freeze(["add", "remove", "replace"]);

export function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const CLI_PROVIDER_INTEGER_LIMITS = deepFreeze({
  timeoutMs: {
    "codex-cli": { minimum: 1_000, maximum: 3_600_000 },
    "claude-cli": { minimum: 1_000, maximum: 3_600_000 },
  },
  maxResponseBytes: {
    "codex-cli": { minimum: 1_024, maximum: 1024 * 1024 },
    "claude-cli": { minimum: 1_024, maximum: 1024 * 1024 },
  },
  maxRequestBytes: {
    "codex-cli": { minimum: 1_024, maximum: 1024 * 1024 },
    "claude-cli": { minimum: 1_024, maximum: 1024 * 1024 },
  },
});

export const CONFIGURATION_FORM_GROUPS = deepFreeze([
  {
    id: "general",
    label: "基础与 PR 范围",
    description: "服务刷新、GitHub 读取边界、身份和需要跟踪的仓库。",
    roots: ["port", "refreshMinutes", "browserPollSeconds", "githubLogin", "githubRead", "trackedRepositories", "prResponsibility"],
  },
  {
    id: "brains",
    label: "大脑 Provider",
    description: "本地端点、经授权的远程模型，以及单任务受监管的 CLI 大脑。",
    roots: ["brain", "brainProviders"],
  },
  {
    id: "employees",
    label: "员工与岗位",
    description: "每个岗位的使命、调度、大脑和允许提出的动作。",
    roots: ["employees"],
  },
  {
    id: "routing",
    label: "工作流路由",
    description: "按事件事实把工作分派给岗位、人员或后续节点。",
    roots: ["workflowRouting"],
  },
  {
    id: "execution",
    label: "代码执行与工作区",
    description: "受控工作区、容器和固定验证 Profile。",
    roots: ["codeExecutor"],
  },
  {
    id: "delivery",
    label: "变更包与 GitHub 动作",
    description: "本地变更包、GitHub 动作，以及自动 Review 和我的 PR 修复开关。",
    roots: ["changePackages", "githubActions"],
  },
  {
    id: "coordination",
    label: "协作与授权策略",
    description: "角色能力、代码操作、仓库工作区和运行限额。",
    roots: ["workCoordination"],
  },
  {
    id: "memory",
    label: "记忆",
    description: "本地记录、可选导入以及有引用依据的回答大脑。",
    roots: ["memory"],
  },
  {
    id: "notifications",
    label: "外部通知",
    description: "钉钉通知范围和每轮发送上限。",
    roots: ["dingtalk"],
  },
]);

const LABELS = deepFreeze({
  port: "服务端口",
  refreshMinutes: "数据刷新（分钟）",
  browserPollSeconds: "浏览器轮询（秒）",
  githubLogin: "GitHub 登录名",
  githubRead: "GitHub 读取",
  pullRequestUpdatedWindow: "自动发现 PR 更新时间",
  issueActiveWindowDays: "Issue 自动处理最近天数",
  mode: "时间范围模式",
  days: "最近天数",
  fromInclusive: "UTC 开始边界（含）",
  untilExclusive: "UTC 结束边界（不含）",
  timeZone: "IANA 时区",
  trackedRepositories: "跟踪仓库",
  prResponsibility: "PR 责任范围",
  historicalAfterDays: "PR 自动处理最近天数",
  codeExecutor: "代码执行器",
  enabled: "启用",
  docker: "Docker",
  executable: "可执行命令",
  host: "本地端点",
  workspaces: "受控工作区",
  profiles: "验证 Profile",
  asset: "自动化测试资产",
  resources: "固定资源",
  title: "测试名称",
  description: "用途说明",
  source: "测试脚本",
  requiredProfilesByWorkspace: "工作区 Profile 绑定",
  brokerLimits: "文件代理限额",
  executorLimits: "执行器限额",
  maxArtifactBytes: "最大产物字节数",
  conflictPreparation: "冲突准备",
  baseMirrorsByRepository: "Base 仓库 Mirror",
  headMirrorsByRepository: "Head 仓库 Mirror",
  id: "标识",
  sourceRoot: "源码根目录",
  gitHeadSnapshot: "Git Head 固定快照",
  writablePaths: "可写路径",
  excludePaths: "排除路径",
  kind: "类型",
  image: "固定镜像",
  timeoutMs: "超时（毫秒）",
  maxFiles: "最大文件数",
  maxDirectories: "最大目录数",
  maxFileBytes: "单文件最大字节数",
  maxTotalBytes: "总读取最大字节数",
  maxSearchMatches: "最大搜索结果数",
  maxWriteBytes: "最大写入字节数",
  maxSessions: "最大会话数",
  maxActionsPerSession: "单会话最大动作数",
  changePackages: "变更包",
  gitCommand: "固定 Git 命令",
  gitTimeoutMs: "Git 超时（毫秒）",
  githubActions: "GitHub 动作",
  automaticReview: "自动 Review（当前 Assign 给我的 PR，自动发布与交接）",
  assignAfterAutomaticReview: "自动分配 Review 后续（通过交测试，需修改或评论交作者）",
  automaticOwnPrRepair: "自动修复我的 PR",
  enabledActions: "启用的 PR 外部动作",
  actorAccountId: "GitHub 操作账号",
  credentialMode: "GitHub 凭据来源",
  tokenEnv: "GitHub Token 环境变量",
  ghCommand: "固定 GitHub CLI 命令",
  networkEnv: "网络环境映射",
  workflowRouting: "工作流路由",
  schemaVersion: "Schema 版本",
  maxHops: "最大跳数",
  rules: "路由规则",
  source: "来源节点",
  priority: "优先级",
  fallback: "兜底规则",
  condition: "匹配条件",
  conditions: "子条件",
  op: "操作符",
  path: "事实路径",
  value: "比较值",
  values: "候选值",
  patterns: "Glob 模式",
  targets: "分派目标",
  type: "目标类型",
  onMatch: "命中后行为",
  workCoordination: "协作与授权",
  tickSeconds: "调度周期（秒）",
  intakeLimit: "接收上限",
  workLimit: "工作上限",
  dispatchLimit: "分派上限",
  attentionLimit: "关注上限",
  proposalLimit: "提案上限",
  conditionLimit: "条件上限",
  codeJobLimit: "代码任务上限",
  codeJobMemoryLimit: "代码任务记忆上限",
  leaseDurationMs: "租约时长（毫秒）",
  resolveTimeoutMs: "解析超时（毫秒）",
  decisionTimeoutMs: "决策超时（毫秒）",
  maxAttempts: "最大尝试次数",
  retryBaseMs: "重试基础间隔（毫秒）",
  retryMaxMs: "最大重试间隔（毫秒）",
  factMaximumAgeMs: "事实最大时效（毫秒）",
  codeJobMaximumTurns: "代码任务最大轮数",
  codeJobObservationLimit: "代码任务观察上限",
  policy: "策略",
  version: "策略版本",
  capabilityRoles: "能力岗位映射",
  githubReviewRoles: "GitHub Review 岗位",
  codeActionRoles: "代码动作岗位",
  configurationChangeRoles: "配置变更提案岗位",
  codeOperationsByRole: "岗位代码操作映射",
  workspaceByRepository: "仓库工作区映射",
  testingOwnersByProduct: "各版本测试负责人",
  reviewOwnersByProduct: "各版本外部 Reviewer",
  memory: "记忆",
  maximumRecords: "最大记录数",
  maximumStateBytes: "最大状态字节数",
  imports: "导入来源",
  localSessions: "本地会话",
  git: "Git 历史",
  answering: "记忆回答",
  maximumContextBytes: "最大上下文字节数",
  maximumConcurrent: "最大并发数",
  brain: "大脑",
  taskBrain: "任务大脑",
  primaryBrain: "主推进大脑（既有大脑为备选）",
  localBrain: "本地大脑",
  provider: "Provider",
  model: "模型",
  reasoningEffort: "推理档位",
  remoteData: "远程数据授权",
  requirements: "需求数据",
  code: "代码数据",
  remote: "远程端点",
  baseUrl: "服务地址",
  apiKeyEnv: "API 凭据环境变量",
  credentialMode: "认证方式",
  responseFormat: "结构化输出模式",
  maxResponseBytes: "最大响应字节数",
  maxRequestBytes: "最大请求字节数",
  contextTokens: "上下文 Token",
  numCtx: "上下文窗口",
  maxAssessmentsPerRefresh: "每轮最大评估数",
  employees: "员工",
  prReviewer: "PR 推进员工",
  roles: "岗位",
  name: "名称",
  initialPaused: "初始暂停",
  policyVersion: "策略版本",
  tickMinutes: "巡检周期（分钟）",
  maxJobsPerTick: "每轮最大任务数",
  retryMinutes: "重试间隔（分钟）",
  maxPatchCharacters: "补丁最大字符数",
  memoryLimit: "记忆上限",
  memoryOutboxLimit: "记忆发件箱上限",
  jobLimit: "任务上限",
  allowRemoteCodeContext: "允许远程代码上下文",
  mission: "岗位使命",
  scheduleMinutes: "调度周期（分钟）",
  workerId: "员工标识",
  permissions: "权限",
  allowedIntents: "允许意图",
  dingtalk: "钉钉通知",
  mailEnabled: "邮件自动摘要（最近 24 小时）",
  selfUserId: "钉钉本人 ID",
  notifyMinimumScore: "最低通知分数",
  maxNotificationsPerRun: "每轮通知上限",
});

const INTEGER_FIELDS = deepFreeze([
  { pattern: ["port"], minimum: 1, maximum: 65_535 },
  { pattern: ["refreshMinutes"], minimum: 1, maximum: 1_440 },
  { pattern: ["browserPollSeconds"], minimum: 1, maximum: 86_400 },
  {
    pattern: ["githubRead", "pullRequestUpdatedWindow", "days"],
    minimum: 1,
    maximum: 3_650,
  },
  {
    pattern: ["githubRead", "issueActiveWindowDays"],
    minimum: 1,
    maximum: 3_650,
  },
  { pattern: ["prResponsibility", "historicalAfterDays"], minimum: 0, maximum: 10_000 },
  { pattern: ["workflowRouting", "schemaVersion"], minimum: 1, maximum: 1, options: [1] },
  { pattern: ["workflowRouting", "maxHops"], minimum: 1, maximum: 32 },
  { pattern: ["workflowRouting", "rules", "#", "priority"], minimum: -10_000, maximum: 10_000 },
  { pattern: ["codeExecutor", "profiles", "*", "timeoutMs"], minimum: 1_000, maximum: 600_000 },
  { pattern: ["codeExecutor", "gitTimeoutMs"], minimum: 1, maximum: 60_000 },
  { pattern: ["codeExecutor", "brokerLimits", "*"], minimum: 1, maximum: 2 ** 31 - 1 },
  { pattern: ["codeExecutor", "executorLimits", "*"], minimum: 1, maximum: 2 ** 31 - 1 },
  { pattern: ["codeExecutor", "maxArtifactBytes"], minimum: 1, maximum: 2 ** 31 - 1 },
  { pattern: ["changePackages", "gitTimeoutMs"], minimum: 1, maximum: 60_000 },
  { pattern: ["githubActions", "timeoutMs"], minimum: 1_000, maximum: 600_000 },
  { pattern: ["workCoordination", "policy", "version"], minimum: 1, maximum: 1_000_000 },
  ...[
    "tickSeconds",
    "intakeLimit",
    "workLimit",
    "dispatchLimit",
    "attentionLimit",
    "proposalLimit",
    "conditionLimit",
    "codeJobLimit",
    "codeJobMemoryLimit",
    "leaseDurationMs",
    "resolveTimeoutMs",
    "decisionTimeoutMs",
    "maxAttempts",
    "retryBaseMs",
    "retryMaxMs",
    "factMaximumAgeMs",
    "codeJobMaximumTurns",
    "codeJobObservationLimit",
  ].map((name) => ({ pattern: ["workCoordination", name], minimum: 1, maximum: 2 ** 31 - 1 })),
  { pattern: ["memory", "maximumRecords"], minimum: 1, maximum: 10_000_000 },
  { pattern: ["memory", "maximumStateBytes"], minimum: 1_024, maximum: 2 ** 31 - 1 },
  { pattern: ["memory", "answering", "maximumRecords"], minimum: 1, maximum: 1_000 },
  { pattern: ["memory", "answering", "maximumContextBytes"], minimum: 1_024, maximum: 128 * 1_024 },
  { pattern: ["memory", "answering", "maximumConcurrent"], minimum: 1, maximum: 16 },
  { pattern: ["brainProviders", "*", "contextTokens"], minimum: 1_024, maximum: 128 * 1_024 },
  {
    pattern: ["brainProviders", "*", "timeoutMs"],
    minimum: 1,
    maximum: 3_600_000,
    limitsByProviderKind: CLI_PROVIDER_INTEGER_LIMITS.timeoutMs,
  },
  {
    pattern: ["brainProviders", "*", "maxResponseBytes"],
    minimum: 1,
    maximum: 2 * 1024 * 1024,
    limitsByProviderKind: CLI_PROVIDER_INTEGER_LIMITS.maxResponseBytes,
  },
  {
    pattern: ["brainProviders", "*", "maxRequestBytes"],
    minimum: 1,
    maximum: 2 * 1024 * 1024,
    limitsByProviderKind: CLI_PROVIDER_INTEGER_LIMITS.maxRequestBytes,
  },
  ...["timeoutMs", "numCtx", "contextTokens", "maxAssessmentsPerRefresh"].map(
    (name) => ({ pattern: ["brain", name], minimum: 1, maximum: 2 ** 31 - 1 }),
  ),
  { pattern: ["employees", "prReviewer", "policyVersion"], minimum: 1, maximum: 1_000_000 },
  { pattern: ["employees", "prReviewer", "tickMinutes"], minimum: 1, maximum: 1_440 },
  { pattern: ["employees", "prReviewer", "maxJobsPerTick"], minimum: 1, maximum: 1_000 },
  { pattern: ["employees", "prReviewer", "maxAttempts"], minimum: 1, maximum: 100 },
  { pattern: ["employees", "prReviewer", "retryMinutes", "#"], minimum: 1, maximum: 43_200 },
  { pattern: ["employees", "prReviewer", "maxPatchCharacters"], minimum: 1, maximum: 10_000_000 },
  { pattern: ["employees", "prReviewer", "memoryLimit"], minimum: 1, maximum: 1_000_000 },
  { pattern: ["employees", "prReviewer", "memoryOutboxLimit"], minimum: 1, maximum: 100_000 },
  { pattern: ["employees", "prReviewer", "jobLimit"], minimum: 1, maximum: 1_000_000 },
  ...["timeoutMs", "numCtx", "contextTokens", "maxAssessmentsPerRefresh"].map(
    (name) => ({
      pattern: ["employees", "prReviewer", "brain", name],
      minimum: 1,
      maximum: 2 ** 31 - 1,
    }),
  ),
  { pattern: ["employees", "roles", "*", "scheduleMinutes"], minimum: 0, maximum: 1_440 },
  { pattern: ["dingtalk", "notifyMinimumScore"], minimum: 0, maximum: 100 },
  { pattern: ["dingtalk", "maxNotificationsPerRun"], minimum: 1, maximum: 1_000 },
]);

const FIELD_RULES = deepFreeze([
  {
    pattern: ["githubRead", "pullRequestUpdatedWindow", "mode"],
    control: "select",
    kind: "text",
    options: ["rolling", "fixed"],
    optionLabels: {
      rolling: "最近 N 天（按 24 小时滚动）",
      fixed: "固定日期范围（首尾日期都包含）",
    },
  },
  { pattern: ["**", "enabled"], control: "checkbox", kind: "boolean" },
  { pattern: ["dingtalk", "mailEnabled"], control: "checkbox", kind: "boolean",
    help: "只读采集当前企业邮箱最近 24 小时的收件箱，合并同主题 GitHub 通知，优先汇总与你相关且需要行动的邮件；加入每日 9 点总报及后续定时汇报。关闭后停止采集，不修改邮件。" },
  { pattern: ["githubActions", "automaticReview"], control: "checkbox", kind: "boolean" },
  { pattern: ["githubActions", "assignAfterAutomaticReview"], control: "checkbox", kind: "boolean" },
  {
    pattern: ["githubActions", "automaticOwnPrRepair"],
    control: "checkbox",
    kind: "boolean",
    help: "自己的 PR 收到评审修改意见后，交给开发工程师在受控工作区修复、运行已配置的验证并推送到原 PR，无需逐项确认。与评审他人的 PR 分别开关；不自动合并，也无需另行开启通用 push 权限。",
  },
  { pattern: ["codeExecutor", "workspaces", "#", "gitHeadSnapshot"], control: "checkbox", kind: "boolean" },
  { pattern: ["**", "initialPaused"], control: "checkbox", kind: "boolean" },
  { pattern: ["employees", "prReviewer", "allowRemoteCodeContext"], control: "checkbox", kind: "boolean" },
  { pattern: ["brainProviders", "*", "remote"], control: "checkbox", kind: "boolean" },
  { pattern: ["workflowRouting", "rules", "#", "fallback"], control: "checkbox", kind: "boolean" },
  { pattern: ["memory", "imports", "*"], control: "checkbox", kind: "boolean" },
  { pattern: ["**", "remoteData", "requirements"], control: "checkbox", kind: "boolean" },
  { pattern: ["**", "remoteData", "code"], control: "checkbox", kind: "boolean" },
  { pattern: ["**", "remoteData", "memory"], control: "checkbox", kind: "boolean" },
  { pattern: ["**", "remoteData", "dingtalk"], control: "checkbox", kind: "boolean" },
  { pattern: ["brain", "allowRemoteDingTalkSummary"], control: "checkbox", kind: "boolean", label: "允许 Luna 处理钉钉摘要" },
  { pattern: ["brainProviders", "*", "apiKeyEnv"], control: "env-reference", kind: "text", format: "environment", maximumBytes: 128 },
  {
    pattern: ["brainProviders", "*", "credentialMode"],
    control: "select",
    kind: "text",
    providerKinds: ["codex-cli", "claude-cli"],
    optionsByProviderKind: {
      "codex-cli": ["codex-login", "codex-native-login", "api-key"],
      "claude-cli": ["api-key"],
    },
    optionLabels: {
      "codex-login": "Codex 受管登录（兼容）",
      "codex-native-login": "Codex 原生登录（会话由 CLI 保存）",
      "api-key": "环境变量 API Key",
    },
    help: "Codex 原生登录直接使用服务账号启动时的 CODEX_HOME（未设置时为该账号的 .codex），认证和会话由 CLI 保存；受管登录保留现有凭据镜像和会话归档流程。模式需明确选择，不自动切换，也不自动迁移旧会话。Claude 仅支持 API Key。",
  },
  {
    pattern: ["githubActions", "credentialMode"],
    control: "select",
    kind: "text",
    options: ["gh-login", "token-env"],
    optionLabels: {
      "gh-login": "GitHub CLI 当前登录（推荐）",
      "token-env": "环境变量 Token（兼容）",
    },
  },
  { pattern: ["githubActions", "tokenEnv"], control: "env-reference", kind: "text", format: "environment", maximumBytes: 128 },
  { pattern: ["brainProviders", "*", "kind"], control: "text", kind: "text", readOnly: true },
  { pattern: ["brainProviders", "*", "maxConcurrentTurns"], control: "number", kind: "integer", minimum: 1, maximum: 4, label: "原生模型并发上限", help: "默认 1。不同任务可共享已验证的容量，同一任务仍串行；提高上限前须验证本机执行、取消和清理。" },
  { pattern: ["brainProviders", "*", "protocol"], control: "select", kind: "text", options: ["chat-completions", "responses"] },
  { pattern: ["brainProviders", "*", "responseFormat"], control: "select", kind: "text", options: ["json-schema", "json-object"] },
  { pattern: ["codeExecutor", "profiles", "*", "kind"], control: "select", kind: "text", options: ["node-test", "node-script", "windows-test", "windows-build"], optionLabels: { "node-test": "Node 内置测试发现", "node-script": "容器测试库脚本", "windows-test": "Windows 固定测试", "windows-build": "Windows 固定构建" } },
  { pattern: ["codeExecutor", "profiles", "*", "nodeExecutable"], control: "text", kind: "text", maximumBytes: 4096 },
  { pattern: ["codeExecutor", "profiles", "*", "nodeSha256"], control: "text", kind: "text", maximumBytes: 64 },
  { pattern: ["codeExecutor", "profiles", "*", "asset", "schemaVersion"], control: "number", kind: "integer", minimum: 1, maximum: 1 },
  { pattern: ["codeExecutor", "profiles", "*", "asset", "version"], control: "number", kind: "integer", minimum: 1, maximum: 1_000_000 },
  { pattern: ["codeExecutor", "profiles", "*", "asset", "source"], control: "textarea", kind: "text", maximumBytes: 65_536 },
  { pattern: ["codeExecutor", "profiles", "*", "resources", "#", "name"], control: "text", kind: "text", format: "resource-name", maximumBytes: 64, label: "资源名称" },
  { pattern: ["codeExecutor", "profiles", "*", "resources", "#", "sourcePath"], control: "text", kind: "text", format: "windows-absolute-path", maximumBytes: 4096, label: "Windows 来源路径" },
  { pattern: ["codeExecutor", "profiles", "*", "resources", "#", "sha256"], control: "text", kind: "text", format: "sha256", maximumBytes: 64, label: "SHA-256" },
  { pattern: ["codeExecutor", "profiles", "*", "resources", "#", "kind"], control: "select", kind: "text", options: ["file", "directory"], optionLabels: { file: "文件", directory: "目录" }, label: "资源类型" },
  { pattern: ["workflowRouting", "rules", "#", "targets", "#", "type"], control: "select", kind: "text", options: ["role", "person", "node"] },
  { pattern: ["workflowRouting", "rules", "#", "onMatch"], control: "select", kind: "text", options: ["stop", "continue"] },
  { pattern: ["workflowRouting", "rules", "#", "condition", "**", "op"], control: "select", kind: "text", options: ["all", "any", "not", "equals", "oneOf", "hasAny", "hasAll", "globAny", "globAll", "atLeast"] },
  { pattern: ["employees", "roles", "*", "permissions", "allowedIntents", "#"], control: "select", kind: "text", options: ["ask_user", "wait_condition", "query_memory", "propose_github_review", "propose_github_pull_request_action", "propose_code_action", "propose_configuration_change", "handoff", "complete", "orchestrate", "submit_delivery"] },
  { pattern: ["githubActions", "enabledActions", "#"], control: "select", kind: "text", options: ["comment", "review", "update_branch", "push", "merge"] },
  { pattern: ["workCoordination", "policy", "codeOperationsByRole", "*", "#"], control: "select", kind: "text", options: ["inspect", "modify", "verify"] },
  { pattern: ["brain", "provider"], control: "select", kind: "text", options: ["ollama"] },
  { pattern: ["brain", "primaryBrain", "provider"], control: "select", kind: "text", format: "safe-id", maximumBytes: 128, optionsFrom: "brainProviders" },
  { pattern: ["employees", "prReviewer", "brain", "provider"], control: "select", kind: "text", options: ["ollama"] },
  ...[
    ["employees", "prReviewer", "primaryBrain", "provider"],
    ["employees", "roles", "*", "brain", "provider"],
    ["employees", "roles", "*", "taskBrain", "provider"],
    ["memory", "answering", "brain", "provider"],
    ["memory", "answering", "localBrain", "provider"],
  ].map((pattern) => ({
    pattern,
    control: "select",
    kind: "text",
    format: "safe-id",
    maximumBytes: 128,
    optionsFrom: "brainProviders",
  })),
  {
    pattern: ["**", "reasoningEffort"],
    control: "select",
    kind: "text",
    options: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  { pattern: ["githubLogin"], kind: "text", format: "github-login", maximumBytes: 40 },
  { pattern: ["githubActions", "actorAccountId"], kind: "text", format: "github-login", maximumBytes: 40 },
  { pattern: ["githubActions", "ghCommand"], kind: "text", format: "absolute-local-path", maximumBytes: 4_096 },
  { pattern: ["githubActions", "networkEnv", "*"], kind: "text", maximumBytes: 4_096 },
  { pattern: ["changePackages", "gitCommand"], kind: "text", maximumBytes: 4_096 },
  { pattern: ["codeExecutor", "gitCommand"], kind: "text", maximumBytes: 4_096 },
  { pattern: ["codeExecutor", "conflictPreparation", "baseMirrorsByRepository", "*"], kind: "text", format: "absolute-local-path", maximumBytes: 4_096 },
  { pattern: ["codeExecutor", "conflictPreparation", "headMirrorsByRepository", "*"], kind: "text", format: "absolute-local-path", maximumBytes: 4_096 },
  { pattern: ["trackedRepositories", "#"], kind: "text", format: "repository", maximumBytes: 256 },
  { pattern: ["workCoordination", "policy", "capabilityRoles", "*"], kind: "text", format: "role-id", maximumBytes: 128 },
  { pattern: ["workCoordination", "policy", "githubReviewRoles", "#"], kind: "text", format: "role-id", maximumBytes: 128 },
  { pattern: ["workCoordination", "policy", "codeActionRoles", "#"], kind: "text", format: "role-id", maximumBytes: 128 },
  { pattern: ["workCoordination", "policy", "configurationChangeRoles", "#"], kind: "text", format: "role-id", maximumBytes: 128 },
  { pattern: ["workCoordination", "policy", "workspaceByRepository", "*"], kind: "text", format: "workspace-id", maximumBytes: 64 },
  { pattern: ["workCoordination", "policy", "testingOwnersByProduct", "*", "#"], kind: "text", format: "github-login", maximumBytes: 40 },
  { pattern: ["workCoordination", "policy", "reviewOwnersByProduct", "*", "#"], kind: "text", format: "github-login", maximumBytes: 40 },
  { pattern: ["codeExecutor", "profiles", "*", "image"], kind: "text", format: "pinned-image", maximumBytes: 1_024 },
  { pattern: ["codeExecutor", "workspaces", "#", "id"], kind: "text", format: "workspace-id", maximumBytes: 64 },
  { pattern: ["codeExecutor", "workspaces", "#", "sourceRoot"], kind: "text", maximumBytes: 4_096 },
  { pattern: ["codeExecutor", "workspaces", "#", "writablePaths", "#"], kind: "text", format: "workspace-path", maximumBytes: 4_096 },
  { pattern: ["codeExecutor", "workspaces", "#", "excludePaths", "#"], kind: "text", format: "workspace-path", maximumBytes: 4_096 },
  { pattern: ["codeExecutor", "requiredProfilesByWorkspace", "*", "#"], kind: "text", format: "profile-id", maximumBytes: 64 },
  { pattern: ["codeExecutor", "docker", "executable"], kind: "text", maximumBytes: 4_096 },
  { pattern: ["codeExecutor", "docker", "host"], kind: "text", format: "docker-host", maximumBytes: 2_048 },
  { pattern: ["brainProviders", "*", "baseUrl"], kind: "text", format: "endpoint", maximumBytes: 2_048 },
  { pattern: ["brainProviders", "*", "model"], kind: "text", maximumBytes: 256 },
  { pattern: ["brain", "baseUrl"], kind: "text", format: "endpoint", maximumBytes: 2_048 },
  { pattern: ["brain", "model"], kind: "text", maximumBytes: 256 },
  { pattern: ["brain", "primaryBrain", "model"], kind: "text", maximumBytes: 256 },
  { pattern: ["employees", "prReviewer", "name"], kind: "text", maximumBytes: 256 },
  { pattern: ["employees", "prReviewer", "brain", "model"], kind: "text", maximumBytes: 256 },
  { pattern: ["employees", "prReviewer", "primaryBrain", "model"], kind: "text", maximumBytes: 256 },
  { pattern: ["employees", "prReviewer", "brain", "baseUrl"], kind: "text", format: "endpoint", maximumBytes: 2_048 },
  { pattern: ["employees", "roles", "*", "name"], kind: "text", maximumBytes: 256 },
  { pattern: ["employees", "roles", "*", "mission"], kind: "text", maximumBytes: 4_096 },
  { pattern: ["employees", "roles", "*", "workerId"], kind: "text", format: "role-id", maximumBytes: 128 },
  { pattern: ["employees", "roles", "*", "brain", "model"], kind: "text", maximumBytes: 256 },
  { pattern: ["employees", "roles", "*", "taskBrain", "model"], kind: "text", maximumBytes: 256 },
  { pattern: ["memory", "answering", "brain", "model"], kind: "text", maximumBytes: 256 },
  { pattern: ["memory", "answering", "localBrain", "model"], kind: "text", maximumBytes: 256 },
  { pattern: ["workflowRouting", "rules", "#", "id"], kind: "text", format: "safe-id-insensitive", maximumBytes: 128 },
  { pattern: ["workflowRouting", "rules", "#", "source"], kind: "text", format: "safe-id-insensitive", maximumBytes: 128 },
  { pattern: ["workflowRouting", "rules", "#", "targets", "#", "id"], kind: "text", format: "safe-id-insensitive", maximumBytes: 128 },
  { pattern: ["workflowRouting", "rules", "#", "condition", "**", "path"], kind: "text", format: "condition-path", maximumBytes: 512 },
  { pattern: ["workflowRouting", "rules", "#", "condition", "**", "value"], control: "scalar", kind: "scalar", maximumBytes: 512 },
  { pattern: ["workflowRouting", "rules", "#", "condition", "**", "values", "#"], control: "scalar", kind: "scalar", maximumBytes: 512 },
  { pattern: ["workflowRouting", "rules", "#", "condition", "**", "patterns", "#"], kind: "text", maximumBytes: 256 },
  { pattern: ["dingtalk", "selfUserId"], kind: "text", maximumBytes: 128 },
  { pattern: ["workflowRouting", "rules", "#", "condition"], control: "select", kind: "scalar", options: [null] },
]);

const COLLECTIONS = deepFreeze([
  { pattern: ["trackedRepositories"], kind: "array", label: "跟踪仓库", template: "repository", maximum: 1_000, uniqueBy: "value" },
  {
    pattern: ["brainProviders"],
    kind: "map",
    label: "大脑 Provider",
    template: "provider",
    keyTemplate: "new-provider",
    additionalTemplates: [
      {
        id: "openai-responses",
        label: "Responses / Codex API 大脑",
        template: "provider-openai-responses",
        keyTemplate: "codex-api",
      },
      {
        id: "ollama",
        label: "Ollama 大脑",
        template: "provider-ollama",
        keyTemplate: "new-ollama",
      },
      {
        id: "codex-cli",
        label: "Codex CLI（单任务受监管）",
        template: "provider-codex-cli",
        keyTemplate: "codex-cli",
      },
      {
        id: "claude-cli",
        label: "Claude CLI（单任务受监管）",
        template: "provider-claude-cli",
        keyTemplate: "claude-cli",
      },
    ],
    maximum: 100,
    keyFormat: "safe-id",
  },
  { pattern: ["employees", "roles"], kind: "map", label: "岗位", template: "role", keyTemplate: "new-role", maximum: 256, keyFormat: "role-id" },
  { pattern: ["employees", "roles", "*", "permissions", "allowedIntents"], kind: "array", label: "允许意图", template: "intent", minimum: 1, maximum: 11, uniqueBy: "value" },
  { pattern: ["employees", "prReviewer", "retryMinutes"], kind: "array", label: "重试间隔", template: "retry-minute", minimum: 1, maximum: 32, uniqueBy: "value" },
  { pattern: ["codeExecutor", "workspaces"], kind: "array", label: "受控工作区", template: "workspace", maximum: 100, uniqueBy: "id", optional: true },
  { pattern: ["codeExecutor", "workspaces", "#", "writablePaths"], kind: "array", label: "可写路径", template: "workspace-path", maximum: 256, uniqueBy: "value" },
  { pattern: ["codeExecutor", "workspaces", "#", "excludePaths"], kind: "array", label: "排除路径", template: "workspace-path", maximum: 256, uniqueBy: "value" },
  { pattern: ["codeExecutor", "profiles", "*", "resources"], kind: "array", label: "固定资源", template: "windows-resource", maximum: 16, uniqueBy: "name", optional: true, profileKinds: ["windows-test", "windows-build"] },
  {
    pattern: ["codeExecutor", "profiles"],
    kind: "map",
    label: "验证 Profile",
    template: "profile",
    keyTemplate: "new-profile",
    additionalTemplates: [
      {
        id: "node-script",
        label: "可复用自动化测试脚本",
        template: "profile-node-script",
        keyTemplate: "reusable-test",
      },
      { id: "windows-test", label: "Windows 固定测试", template: "profile-windows-test", keyTemplate: "windows-test" },
      { id: "windows-build", label: "Windows 固定构建", template: "profile-windows-build", keyTemplate: "windows-build" },
    ],
    maximum: 100,
    keyFormat: "profile-id",
    optional: true,
  },
  { pattern: ["codeExecutor", "requiredProfilesByWorkspace"], kind: "map", label: "工作区 Profile 绑定", template: "profile-binding", keyTemplate: "workspace-id", maximum: 256, keyFormat: "workspace-id", optional: true },
  { pattern: ["codeExecutor", "requiredProfilesByWorkspace", "*"], kind: "array", label: "所需 Profile", template: "profile-id", minimum: 1, maximum: 100, uniqueBy: "value" },
  { pattern: ["codeExecutor", "conflictPreparation", "baseMirrorsByRepository"], kind: "map", label: "Base 仓库 Mirror", template: "local-mirror-path", keyTemplate: "owner/repository", minimum: 1, maximum: 1_000, keyFormat: "controlled-git-repository", optional: true },
  { pattern: ["codeExecutor", "conflictPreparation", "headMirrorsByRepository"], kind: "map", label: "Head 仓库 Mirror", template: "local-mirror-path", keyTemplate: "owner/repository", minimum: 1, maximum: 1_000, keyFormat: "controlled-git-repository", optional: true },
  { pattern: ["githubActions", "networkEnv"], kind: "map", label: "网络环境映射", template: "network-env", keyTemplate: "HTTPS_PROXY", maximum: 6, keyOptions: ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"], optional: true },
  { pattern: ["githubActions", "enabledActions"], kind: "array", label: "启用的 PR 外部动作", template: "github-pr-action", maximum: 5, uniqueBy: "value", optional: true },
  { pattern: ["workflowRouting", "rules"], kind: "array", label: "路由规则", template: "routing-rule", maximum: 200, uniqueBy: "id" },
  { pattern: ["workflowRouting", "rules", "#", "targets"], kind: "array", label: "分派目标", template: "routing-target", minimum: 1, maximum: 20, uniqueBy: "type-id" },
  { pattern: ["workflowRouting", "rules", "#", "condition", "**", "conditions"], kind: "array", label: "子条件", template: "condition", minimum: 1, maximum: 128 },
  { pattern: ["workflowRouting", "rules", "#", "condition", "**", "values"], kind: "array", label: "候选值", template: "condition-value", minimum: 1, maximum: 50, uniqueBy: "typed-value" },
  { pattern: ["workflowRouting", "rules", "#", "condition", "**", "patterns"], kind: "array", label: "Glob 模式", template: "glob-pattern", minimum: 1, maximum: 50, uniqueBy: "value" },
  { pattern: ["workCoordination", "policy", "capabilityRoles"], kind: "map", label: "能力岗位映射", template: "role-id", keyTemplate: "coordination", maximum: 5, keyOptions: ["coordination", "requirements", "pr-review", "development", "testing"] },
  { pattern: ["workCoordination", "policy", "githubReviewRoles"], kind: "array", label: "GitHub Review 岗位", template: "role-id", maximum: 100, uniqueBy: "value" },
  { pattern: ["workCoordination", "policy", "codeActionRoles"], kind: "array", label: "代码动作岗位", template: "role-id", maximum: 100, uniqueBy: "value" },
  { pattern: ["workCoordination", "policy", "configurationChangeRoles"], kind: "array", label: "配置变更提案岗位", template: "role-id", maximum: 100, uniqueBy: "value", optional: true },
  { pattern: ["workCoordination", "policy", "codeOperationsByRole"], kind: "map", label: "岗位代码操作映射", template: "code-operations", keyTemplate: "role-id", maximum: 256, keyFormat: "role-id" },
  { pattern: ["workCoordination", "policy", "codeOperationsByRole", "*"], kind: "array", label: "允许代码操作", template: "code-operation", minimum: 1, maximum: 3, uniqueBy: "value" },
  { pattern: ["workCoordination", "policy", "workspaceByRepository"], kind: "map", label: "仓库工作区映射", template: "workspace-id", keyTemplate: "owner/repository", maximum: 256, keyFormat: "repository" },
  { pattern: ["workCoordination", "policy", "testingOwnersByProduct"], kind: "map", label: "各版本测试负责人", template: "testing-owner-list", keyTemplate: "qt", maximum: 20, keyFormat: "safe-id", optional: true },
  { pattern: ["workCoordination", "policy", "testingOwnersByProduct", "*"], kind: "array", label: "GitHub 测试负责人", template: "github-login", minimum: 1, maximum: 20, uniqueBy: "value" },
  { pattern: ["workCoordination", "policy", "reviewOwnersByProduct"], kind: "map", label: "各版本外部 Reviewer", template: "review-owner-list", keyTemplate: "qt", maximum: 20, keyFormat: "safe-id", optional: true },
  { pattern: ["workCoordination", "policy", "reviewOwnersByProduct", "*"], kind: "array", label: "GitHub Reviewer", template: "github-login", minimum: 1, maximum: 20, uniqueBy: "value" },
]);

const SLOTS = deepFreeze([
  {
    pattern: ["brainProviders", "*", "maxConcurrentTurns"], label: "原生模型并发上限",
    template: "native-model-capacity", providerKinds: ["codex-cli"], optional: true,
    operations: ["add", "remove", "replace"],
  },
  { pattern: ["dingtalk", "mailEnabled"], label: "邮件自动摘要", template: "mail-disabled", optional: true, operations: ["add", "remove", "replace"] },
  { pattern: ["githubActions", "automaticReview"], label: "自动 Review", template: "automatic-review-enabled", optional: true, operations: ["add", "remove", "replace"] },
  { pattern: ["githubActions", "assignAfterAutomaticReview"], label: "Review 后自动分配", template: "automatic-review-enabled", optional: true, operations: ["add", "remove", "replace"] },
  { pattern: ["githubActions", "automaticOwnPrRepair"], label: "自动修复我的 PR", template: "automatic-own-pr-repair-disabled", optional: true, operations: ["add", "remove", "replace"] },
  {
    pattern: ["githubRead", "pullRequestUpdatedWindow"],
    label: "自动发现 PR 更新时间",
    template: "pr-updated-window-rolling",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["githubRead", "issueActiveWindowDays"],
    label: "Issue 自动处理最近天数",
    template: "issue-active-window-days",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["brainProviders", "*", "credentialMode"],
    label: "认证方式",
    template: "provider-credential-mode",
    providerKinds: ["codex-cli", "claude-cli"],
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["githubActions", "credentialMode"],
    label: "GitHub 凭据来源",
    template: "github-credential-mode",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["githubActions", "tokenEnv"],
    label: "GitHub Token 环境变量",
    template: "github-token-env",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["employees", "roles", "*", "taskBrain"],
    label: "任务大脑",
    template: "task-brain",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["employees", "prReviewer", "primaryBrain"],
    label: "主推进大脑（既有大脑为备选）",
    template: "task-brain",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["codeExecutor", "conflictPreparation"],
    label: "冲突准备",
    template: "conflict-preparation",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["codeExecutor", "gitCommand"],
    label: "固定 Git 命令",
    template: "code-executor-git-command",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["codeExecutor", "gitTimeoutMs"],
    label: "Git 超时（毫秒）",
    template: "code-executor-git-timeout",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  {
    pattern: ["codeExecutor", "workspaces", "#", "gitHeadSnapshot"],
    label: "Git Head 固定快照",
    template: "workspace-git-head-snapshot",
    optional: true,
    operations: ["add", "remove", "replace"],
  },
  { pattern: ["workflowRouting", "rules", "#", "condition"], label: "匹配条件", template: "condition", nullable: true, operations: ["add", "remove", "replace"] },
  { pattern: ["workflowRouting", "rules", "#", "condition", "**", "condition"], label: "子条件", template: "condition", nullable: false, operations: ["replace"] },
]);

const TEMPLATES = deepFreeze({
  "mail-disabled": false,
  "pr-updated-window-rolling": { mode: "rolling", days: 7 },
  "issue-active-window-days": 14,
  "automatic-review-enabled": true,
  "automatic-own-pr-repair-disabled": false,
  repository: "owner/repository",
  provider: {
    kind: "openai-compatible",
    baseUrl: "https://models.example.invalid/v1",
    apiKeyEnv: "MYDASHBOARD_MODEL_API_KEY",
    protocol: "chat-completions",
    responseFormat: "json-schema",
    remote: true,
    timeoutMs: 120_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  },
  "provider-openai-responses": {
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "responses",
    responseFormat: "json-schema",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  },
  "provider-ollama": {
    kind: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    remote: false,
    timeoutMs: 120_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
    contextTokens: 8_192,
  },
  "provider-codex-cli": {
    kind: "codex-cli",
    credentialMode: "codex-login",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  },
  "provider-claude-cli": {
    kind: "claude-cli",
    credentialMode: "api-key",
    remote: true,
    timeoutMs: 300_000,
    maxResponseBytes: 131_072,
    maxRequestBytes: 262_144,
  },
  role: {
    name: "新岗位",
    mission: "描述该岗位的职责、边界和完成标准。",
    enabled: false,
    scheduleMinutes: 5,
    initialPaused: true,
    permissions: { allowedIntents: ["ask_user"] },
    brain: {
      provider: "ollama",
      model: "qwen3.5:9b",
      remoteData: { requirements: false, code: false, memory: false },
    },
  },
  "task-brain": {
    provider: "ollama",
    model: "qwen3.5:9b",
    remoteData: { requirements: false, code: false, memory: false },
  },
  "provider-credential-mode": "api-key",
  "native-model-capacity": 1,
  "github-credential-mode": "gh-login",
  "github-token-env": "MYDASHBOARD_GITHUB_TOKEN",
  intent: "ask_user",
  "github-pr-action": "review",
  "retry-minute": 5,
  workspace: {
    id: "workspace-id",
    sourceRoot: ".",
    gitHeadSnapshot: false,
    writablePaths: [],
    excludePaths: [],
  },
  "code-executor-git-command": "C:/Program Files/Git/mingw64/bin/git.exe",
  "code-executor-git-timeout": 30_000,
  "conflict-preparation": { enabled: false },
  "local-mirror-path": "C:/path/to/repository.git",
  "workspace-git-head-snapshot": true,
  "workspace-path": "src",
  profile: { kind: "node-test", image: `node:22-alpine@sha256:${"0".repeat(64)}`, timeoutMs: 120_000 },
  "profile-node-script": {
    kind: "node-script",
    image: `node:22-alpine@sha256:${"0".repeat(64)}`,
    timeoutMs: 120_000,
    asset: {
      schemaVersion: 1,
      title: "可复用自动化测试",
      description: "说明这个脚本验证的稳定行为，以及适合复用的场景。",
      version: 1,
      source: 'throw new Error("Replace this placeholder with assertions before activation");',
    },
  },
  ...Object.fromEntries(["test", "build"].map((kind) => [`profile-windows-${kind}`, {
    kind: `windows-${kind}`,
    nodeExecutable: "C:/Program Files/nodejs/node.exe",
    nodeSha256: "0".repeat(64),
    timeoutMs: 120_000,
    asset: {
      schemaVersion: 1, title: kind === "test" ? "Windows 固定测试" : "Windows 固定构建",
      description: "填写验证范围和运行条件后启用。", version: 1,
      source: 'throw new Error("Replace this placeholder with verified commands before activation");',
    },
  }])),
  "profile-binding": ["profile-id"],
  "windows-resource": { name: "resource", sourcePath: "C:/path/to/resource", sha256: "0".repeat(64), kind: "file" },
  "profile-id": "profile-id",
  "network-env": "http://127.0.0.1:7890",
  "routing-rule": {
    id: "new-rule",
    source: "root",
    enabled: false,
    priority: 0,
    fallback: true,
    condition: null,
    targets: [{ type: "person", id: "owner" }],
    onMatch: "stop",
  },
  "routing-target": { type: "person", id: "owner" },
  condition: { op: "equals", path: "eventType", value: "event.type" },
  "condition-value": "value",
  "glob-pattern": "**/*",
  "role-id": "role-id",
  "code-operations": ["inspect"],
  "code-operation": "inspect",
  "workspace-id": "workspace-id",
  "testing-owner-list": ["github-login"],
  "review-owner-list": ["github-login"],
  "github-login": "github-login",
});

export const CONFIGURATION_FORM_SCHEMA = deepFreeze({
  version: 1,
  groups: CONFIGURATION_FORM_GROUPS,
  fields: [...INTEGER_FIELDS, ...FIELD_RULES],
  collections: COLLECTIONS,
  slots: SLOTS,
  structureOperations: STRUCTURE_OPERATIONS,
});

function normalizePath(path) {
  if (!Array.isArray(path) || Object.getPrototypeOf(path) !== Array.prototype) {
    throw new TypeError("configuration schema path must be an array");
  }
  if (path.length === 0 || path.length > 32) {
    throw new RangeError("configuration schema path exceeds limit");
  }
  const keys = Reflect.ownKeys(path);
  const expected = Array.from({ length: path.length }, (_, index) => `${index}`);
  if (
    keys.length !== expected.length + 1 ||
    !keys.includes("length") ||
    expected.some((key) => !keys.includes(key))
  ) {
    throw new TypeError("configuration schema path must be a dense data array");
  }
  return expected.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(path, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError("configuration schema path must contain data properties");
    }
    const segment = descriptor.value;
    if (
      !(typeof segment === "string" || Number.isSafeInteger(segment)) ||
      `${segment}`.length === 0 ||
      DANGEROUS_KEYS.has(`${segment}`)
    ) {
      throw new TypeError("configuration schema path contains an unsafe segment");
    }
    return `${segment}`;
  });
}

function matches(pattern, path, patternIndex = 0, pathIndex = 0) {
  if (patternIndex === pattern.length) return pathIndex === path.length;
  const expected = pattern[patternIndex];
  if (expected === "**") {
    for (let offset = pathIndex; offset <= path.length; offset += 1) {
      if (matches(pattern, path, patternIndex + 1, offset)) return true;
    }
    return false;
  }
  if (pathIndex >= path.length) return false;
  if (
    expected !== "*" &&
    !(expected === "#" && /^\d+$/.test(path[pathIndex])) &&
    expected !== path[pathIndex]
  ) {
    return false;
  }
  return matches(pattern, path, patternIndex + 1, pathIndex + 1);
}

function matchingRule(rules, path) {
  return rules.find(({ pattern }) => matches(pattern, path));
}

function labelFor(path) {
  const segment = path.at(-1);
  if (/^\d+$/.test(segment)) return `第 ${Number(segment) + 1} 项`;
  return LABELS[segment] || segment.replaceAll(/([a-z])([A-Z])/g, "$1 $2");
}

function defaultField(value) {
  if (value === null) return { control: "scalar", kind: "scalar" };
  if (typeof value === "boolean") return { control: "checkbox", kind: "boolean" };
  if (typeof value === "number") {
    return {
      control: "number",
      kind: Number.isSafeInteger(value) ? "integer" : "number",
    };
  }
  if (typeof value === "string") return { control: "text", kind: "text" };
  throw new TypeError("configuration field value must be primitive");
}

function fieldContext(value) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("configuration field context must be a plain object");
  }
  const keys = Reflect.ownKeys(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "providerKind");
  if (
    keys.length !== 1 ||
    keys[0] !== "providerKind" ||
    !descriptor?.enumerable ||
    !("value" in descriptor) ||
    typeof descriptor.value !== "string"
  ) {
    throw new TypeError("configuration field context is invalid");
  }
  return { providerKind: descriptor.value };
}

export function configurationFieldDescriptor(path, value, context = null) {
  const normalized = normalizePath(path);
  const integerRule = matchingRule(INTEGER_FIELDS, normalized);
  const fieldRule = matchingRule(FIELD_RULES, normalized);
  const normalizedContext = fieldContext(context);
  const contextualFieldRule =
    fieldRule?.providerKinds &&
    !fieldRule.providerKinds.includes(normalizedContext?.providerKind)
      ? null
      : fieldRule;
  const contextualLimits = normalizedContext && integerRule
    ? integerRule.limitsByProviderKind?.[normalizedContext.providerKind]
    : null;
  return deepFreeze({
    label: labelFor(normalized),
    ...defaultField(value),
    ...(integerRule
      ? {
          control: integerRule.options ? "select" : "number",
          kind: "integer",
          ...integerRule,
          ...(contextualLimits || {}),
        }
      : {}),
    ...(contextualFieldRule || {}),
    ...(contextualFieldRule?.optionsByProviderKind
      ? { options: contextualFieldRule.optionsByProviderKind[normalizedContext.providerKind] }
      : {}),
    path: normalized,
  });
}

export function configurationCollectionDescriptor(path, value) {
  const normalized = normalizePath(path);
  const descriptor = matchingRule(COLLECTIONS, normalized);
  if (!descriptor) return null;
  if (value !== undefined) {
    const valid =
      descriptor.kind === "array"
        ? Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
        : value !== null &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.getPrototypeOf(value) === Object.prototype;
    if (!valid) throw new TypeError(`${descriptor.label} must be a ${descriptor.kind}`);
    const keys = Reflect.ownKeys(value);
    if (keys.length > (descriptor.kind === "array" ? 4_097 : 4_096)) {
      throw new RangeError(`${descriptor.label} exceeds the collection limit`);
    }
    const dataKeys = descriptor.kind === "array"
      ? Array.from({ length: value.length }, (_, index) => `${index}`)
      : keys;
    if (
      descriptor.kind === "array" &&
      (keys.length !== value.length + 1 || !keys.includes("length"))
    ) {
      throw new TypeError(`${descriptor.label} must be a dense data array`);
    }
    for (const key of dataKeys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        DANGEROUS_KEYS.has(key) ||
        !property?.enumerable ||
        !("value" in property)
      ) {
        throw new TypeError(`${descriptor.label} must contain safe data properties`);
      }
    }
  }
  return deepFreeze({ ...descriptor, path: normalized, operations: STRUCTURE_OPERATIONS });
}

export function configurationSlotDescriptor(path, context = null) {
  const normalized = normalizePath(path);
  const descriptor = matchingRule(SLOTS, normalized);
  const normalizedContext = fieldContext(context);
  if (
    !descriptor ||
    (descriptor.providerKinds &&
      !descriptor.providerKinds.includes(normalizedContext?.providerKind))
  ) {
    return null;
  }
  return deepFreeze({ ...descriptor, path: normalized });
}

function cloneTemplate(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneTemplate);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneTemplate(child)]),
  );
}

export function configurationStructureTemplate(path, variant = null) {
  const normalized = normalizePath(path);
  const descriptor =
    matchingRule(COLLECTIONS, normalized) || matchingRule(SLOTS, normalized);
  if (!descriptor) {
    throw new TypeError("configuration path is not in the structure operation allowlist");
  }
  if (variant !== null && typeof variant !== "string") {
    throw new TypeError("configuration template variant is invalid");
  }
  const selected = variant === null
    ? descriptor
    : descriptor.additionalTemplates?.find((entry) => entry.id === variant);
  if (!selected) {
    throw new TypeError("configuration template variant is unavailable");
  }
  return deepFreeze({
    kind: descriptor.kind || "slot",
    ...(selected.keyTemplate ? { key: selected.keyTemplate } : {}),
    value: cloneTemplate(TEMPLATES[selected.template]),
  });
}

export function configurationNodeLabel(path) {
  return labelFor(normalizePath(path));
}
