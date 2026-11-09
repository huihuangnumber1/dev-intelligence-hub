# 开发智能中枢 (Development Intelligence Hub)

> **开发中 / Development in Progress** — 当前版本为 `0.1.0`，接口、工作流和文档在首个稳定版本前仍可能调整。

[![CI](https://github.com/huihuangnumber1/dev-intelligence-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/huihuangnumber1/dev-intelligence-hub/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

本地优先的研发指挥中枢，把 GitHub PR、Issue、里程碑/Release 与协作消息合并为行动队列。系统包含可配置路由、持久化工作台账、主动员工循环、统一请示/确认队列，以及可独立配置职责、权限、调度和大脑的主控、需求、PR、开发与测试岗位。

项目与 npm 包统一使用公开名称 Development Intelligence Hub / `dev-intelligence-hub`。为保持已有安装的数据目录、管理脚本、HTTP 头和恢复协议兼容，这些技术标识暂时保留 `MyDashboard`，不代表另一个项目。

## 项目状态

- U1–U10 的本地实现和自动化验收已收口，覆盖受控代码执行、持久工作流、多岗位协作、可引用记忆、版本化配置以及备份恢复。
- U11 已完成 Apache-2.0 许可证、隐私扫描、安全示例配置和干净环境安装等开源分发基线。
- U12 整体验收与由产品自身执行的真实 PR 所有者确认仍待完成；当前版本不应被描述为稳定生产版本。
- 示例配置默认关闭 GitHub 读写、远程模型、代码执行和主动岗位。普通外部写入与高风险动作逐项确认；明确启用自动 Review 或“自动修复我的 PR”后，相应流程按已激活的授权连续执行，并保留结果与审计。

能力、限制与发布门槛的简表见[项目状态](docs/PROJECT_STATUS.md)，完整实施记录见[开发计划](DEVELOPMENT_PLAN.md)。

PR 责任语义遵循团队当前流程：

- 他人创建、Assignee 是我：等待我 Review。
- 当前 Assignee 包含我：由我处理；我创建且尚未分配负责人的 PR：由我继续推进。
- 我创建但当前已分配给他人的 PR：由当前负责人处理，不列为我的待办；审核意见、CI 失败或冲突不会自动把责任转回给我。
- GitHub Review request 不作为任务归属依据；避免 Assignee 已移除后仍残留在审核队列。
- Review 通过并选择测试负责人后，系统先创建可恢复的内部测试工作项，再把 GitHub Assignee 转交给该负责人；重复恢复不会重复创建任务或 Review。

## 使用

日常操作从[中文使用手册](docs/USER_GUIDE.zh-CN.md)开始：按页面介绍总览、岗位、确认队列、工作台账，以及常见“阻塞”和数据源错误。

Windows 受管服务可从配置中心的“连接 Jenkins 构建日志”接入已有构建。连接会先验证访问权限，再将凭据用当前 Windows 用户的 DPAPI 加密存入项目私有运行目录；不会写入版本化配置或模型上下文。岗位按 PR 的失败检查链接读取同仓库、同 Jenkins origin 和任务路径的其他构建，仅调用构建元数据和控制台日志 GET。日志必须同时匹配当前 Head、分支和 Git reset 证据才作为当前失败明细；不可用或旧版本日志不会中断岗位决策，也不会把检查标为通过。非 UTF-8 控制台字符会替换显示并显式标记。

```powershell
npm ci
npm test
.\scripts\Manage-MyDashboard.ps1 -Action Start -OpenBrowser
```

GitHub Actions 会在干净的托管 Windows 环境运行可移植回归。真实 Codex/GitHub 登录生命周期、Windows 私有 ACL 和 PowerShell 服务管理器测试仍保留在 `npm test`，需要在配置好的 Windows 工作站执行；发布验收必须运行完整的 `npm test`，不能用托管 CI 代替。

这是日常使用的推荐启动方式：受管生命周期会认证唯一进程、保留可诊断状态并安全停止。`npm start` 只用于前台开发诊断，不属于受管生命周期，也不能满足 `validate:system -- --all`；不要同时运行两种启动方式。

发布或升级前可运行可重复的整体验收。基础命令执行提交中的完整 Node 回归、全部 JavaScript 语法检查和两组真实浏览器行为测试；`--all` 还要求 Docker Desktop 可用，并要求已经由受管生命周期启动且健康的 `127.0.0.1:4173` 服务完成桌面/移动端验收：

```powershell
npm run setup:validation-browser
npm run validate:system
npm run validate:system -- --all
```

浏览器安装只需在首次安装或 Playwright 升级后执行；它把匹配版本的无窗口 Chromium 存入被 Git 忽略的 `data/playwright-browsers/`。整体验收固定使用该 headless shell，不加载系统浏览器 profile 或宿主输入法，验证本身不会临时联网下载浏览器。

验收必须从干净且已提交的工作树开始；运行期间 HEAD、Git tree 或受跟踪/未跟踪文件发生变化都会使验收失败。普通 Node 测试在只读、无 `.git` 的精确提交物化中执行；必须核对 Git 索引、当前树和发布载荷的开源分发测试，则在前后均核验为同一干净 commit/tree 的仓库中单独执行。两组结果共同构成完整回归，不能省略或互相替代。每次命令都会生成新的 `runId`，并在结束时打印报告路径 `validation-artifacts/runs/<runId>/system-validation.json`；不同验收不会覆盖或误用旧报告。报告记录开始/结束源码身份、经过脱敏的实际命令、退出状态，以及 Node 测试的通过/失败/跳过身份。`--all` 的 UI 结果、真实 PNG 截图和回执也保存在同一 run 目录。

完成 `--all`、保存两份独立最终审查后，可生成同样被忽略的 HEAD 绑定清单。清单要求 Docker 与桌面/移动端 UI 步骤都已通过，并按 SHA-256 绑定验证报告、UI 结果/截图和两份不同审查报告：

```powershell
node scripts/system-acceptance-manifest.mjs `
  --validation-report "validation-artifacts/runs/<runId>/system-validation.json" `
  --review "security-reliability=validation-artifacts/runs/<runId>/reviews/security-reliability.json" `
  --review "maintainability-usability=validation-artifacts/runs/<runId>/reviews/maintainability-usability.json"
```

两份 JSON 是发布负责人对两次独立审查结果的机器可读记录：分别覆盖 `security-reliability` 与 `maintainability-usability`，绑定相同 `runId`、HEAD/tree、验证报告 SHA-256，并给出唯一 review/reviewer run 身份；只有 verdict 为 `ready` 且 P0/P1/P2 均为 0 才能发布清单。清单能验证内容绑定、时间顺序和声明身份不同，但不能认证审查器本人或单独证明两次执行确实独立；发布负责人必须另行保留可信编排器的原始运行记录。清单默认写入 `validation-artifacts/runs/<runId>/system-acceptance-manifest.json`，不会覆盖已有文件。

这些本地产物可能包含运行环境或测试名称，仍应在任何对外使用前人工检查；清单不是许可证选择，也不能代替由产品自身执行的所有者确认真实 PR 验收。

首次启动不需要私人配置：仓库自带的 `config.example.json` 是无真实账号、无仓库、无 GitHub 读取或写入的安全禁用配置。它预置了五个暂停岗位和通用 PR/Issue 路由，但 GitHub 读取、工作协调、路由、记忆、代码执行和外部动作总开关均保持关闭。需要启用功能时，先复制为不入库的本机配置：

```powershell
Copy-Item config.example.json config.json
```

然后只在 `config.json` 或 `config.local.json` 中填写首次导入所需的本机设置；密钥本身只放在环境变量中。首次导入形成活动版本后，以浏览器“配置”页面中的结构化草稿、校验、影响预览和逐项确认激活为准，后续修改启动文件不会静默覆盖活动权限。当前运行时按一个不可变活动版本组装，所以任何确认激活或回滚都会明确进入“需要重启”状态；使用受管重启后，新版本才成为岗位、路由、大脑和权限的实际运行配置。浏览器打开 `http://127.0.0.1:4173`。服务端按配置定时刷新，页面定时读取最新快照；“刷新”按钮可立即采集。

`npm start` 和受管启动都先由安全 bootstrap 对发布文件计算不可变身份，再加载应用模块，并在开放服务前重新核验。Git checkout 必须干净且绑定真实 commit/tree 与进程私有的 HEAD reflog 摘要；即使启动期间从 A 切到 B 又恢复 A，也会失败关闭。不含 `.git` 的 npm 或离线发布包使用同一组发布文件生成确定性身份。该机制提供版本一致性证据，不把同一操作系统用户下的恶意进程视为沙箱外攻击者；启动时不要编辑或切换 checkout。

完整设计、隐私边界、安全报告、运维与贡献说明分别见 [架构](docs/ARCHITECTURE.md)、[隐私](docs/PRIVACY.md)、[安全](SECURITY.md)、[运维](docs/OPERATIONS.md) 和 [贡献指南](CONTRIBUTING.md)。

“跟踪版本”按版本的创建/发布时间倒序展示，最近添加或发布的记录在最上方。

## PR 能力与岗位

启用示例中的工作流路由后，新的 PR 工作默认路由到持久化工作台账中的 `pr-engineer`；旧 `pr-reviewer` 保留原有数据、作业和兼容接口，不再是默认工作流目标。两个岗位首次创建都保持暂停，必须由你在“岗位”页面明确恢复后才会主动领取新工作。

旧 PR 员工的兼容链路仍保留以下能力：

- 每 2 分钟巡查一次最新的成功 GitHub PR 快照；旧快照或失败源不会触发新工作。
- 对需要 Review 的 PR 读取固定 head 的有限 diff，生成与该 Head 绑定的评审方案。
- 对自己创建且需要推进的 PR 读取结构化元数据，生成本地执行方案。
- 未启用 GitHub 写入时，评审方案只保存在本机；启用后，新方案直接进入统一外部动作确认队列，不再二次“接受草稿”。
- 作业带 revision、head 校验、运行租约和重试策略；模型完成后若 head 已变化，草稿会自动失效。
- 分析、证据、步骤、来源 URL、head 和所用大脑会写入本地记忆，可在“记忆搜索”中查询。

## 多岗位与多大脑

安全示例预置 `pr-engineer`、`orchestrator`、`requirements-analyst`、`developer` 和 `tester` 五个岗位；每个岗位分别持久化暂停状态、运行修订号、职责、权限、调度频率和模型。默认大脑是本机 Ollama 的 `qwen3.5:9b`，但 Ollama 不会因读取示例配置而被自动启动或调用。

`brainProviders` 支持本地 Ollama 和 OpenAI-compatible 第三方接口。密钥只从指定环境变量读取，不写入配置或日志。例如，只给需求分析师接入第三方大脑：

```json
{
  "brainProviders": {
    "remote-smart": {
      "kind": "openai-compatible",
      "baseUrl": "https://models.example/v1",
      "apiKeyEnv": "MYDASHBOARD_MODEL_TOKEN",
      "timeoutMs": 120000
    }
  },
  "employees": {
    "roles": {
      "requirements-analyst": {
        "brain": {
          "provider": "remote-smart",
          "model": "更强的第三方模型名",
          "remoteData": {
            "requirements": true,
            "code": false,
            "memory": false
          }
        }
      }
    }
  }
}
```

### 受监管 Codex / Claude CLI 大脑

支持把 Codex CLI 或 Claude CLI 配置为主控或任一员工的 `brain` / `taskBrain`。调度器自动为已领取的任务启动受监管 CLI，传入任务上下文并校验结构化结果；进程按次结束，任务台账持久保存。Codex 可以恢复同一 PR / Issue 的任务会话，保存方式取决于所选认证模式。

首版运行平台是 Windows x64；Codex CLI 使用官方 npm 包，不绑定发行版本范围，Claude CLI 需要 `>=2.1.222 <2.2.0`。CLI 必须安装在启动 MyDashboard 的服务账号 `PATH` 可发现的位置；页面不能填写任意可执行文件路径。系统通过包清单、平台包、父包与原生包版本一致性、真实路径、文件身份与摘要校验安装来源，并在每次调用时验证命令协议、结构化响应、进程退出与清理契约；不符合时稳定返回“Provider 不可用”，不会尝试其他命令。

Codex 有三种明确选择、互不自动回退的认证方式。服务启动时已有的 `CODEX_HOME` 决定本机 Codex 根目录，未设置时使用同一服务账号的 `.codex`；页面和配置不能提供另一个目录。

| `credentialMode` | 登录与会话保存方式 |
| --- | --- |
| `codex-native-login` | 直接使用该服务账号的 Codex 根目录，登录与会话由 CLI 管理。系统不复制认证文件、不建立凭据镜像、不搬运会话目录，只保存任务与会话 ID 的引用。 |
| `codex-login` | 保留兼容的受管登录：校验文件式 `auth.json`，通过私有镜像向一次性 profile 提供认证，任务会话由系统归档和恢复。 |
| `api-key` 或省略字段 | 只使用服务环境的 `OPENAI_API_KEY`，保持旧配置的账号和计费路径。 |

原生模式按服务账号串行执行；会话属于原生 Codex 根目录，不属于任务临时目录。旧受管会话和审计记录保留，切换模式不会自动迁移历史。选择与回滚步骤见[运维手册](docs/OPERATIONS.md#native-codex-migration-and-rollback)。

Claude CLI 首版只支持 `api-key`，从服务环境读取 `ANTHROPIC_API_KEY`；Claude 登录 profile 和 OS keyring 均不受支持。任何 API key 都不能写入配置。一个安全但尚未分配、尚未授权出机的 Provider 示例是：

```json
{
  "brainProviders": {
    "codex-local-cli": {
      "kind": "codex-cli",
      "credentialMode": "codex-login",
      "remote": true,
      "timeoutMs": 300000,
      "maxResponseBytes": 131072,
      "maxRequestBytes": 262144
    },
    "claude-local-cli": {
      "kind": "claude-cli",
      "credentialMode": "api-key",
      "remote": true,
      "timeoutMs": 300000,
      "maxResponseBytes": 131072,
      "maxRequestBytes": 262144
    }
  }
}
```

在“配置”页面选择“Codex CLI（单任务受监管）”或“Claude CLI（单任务受监管）”创建 Provider。Codex 表单保留 `codex-login` 模板默认值，可明确选择“Codex 原生登录（会话由 CLI 保存）”或 API Key；现有配置不会因打开页面或升级而改变。Claude 只能选择 API Key。再把 Provider 和模型分配给岗位的日常大脑或任务大脑。CLI 始终视为远程推理；任务包含需求、代码或记忆时，必须分别打开该岗位对应的 `remoteData` 授权。保存草稿、查看影响并逐项确认激活后，使用受管重启使新版本生效。

配置页的“Codex CLI 大脑能力”卡片只显示脱敏状态：`available`、`file_login_unavailable`、`unsafe_source`、`broker_blocked` 或 `cli_unavailable`。也可在受管服务启动后运行 `node scripts/verify-codex-login-readiness.mjs --origin http://127.0.0.1:4173`；该命令只请求固定本机状态接口，不调用模型、不访问 PR，成功时只打印状态名。

兼容的 `codex-login` 与 API Key 路径使用临时 profile 和独立工作目录；受管登录的刷新结果只进入私有镜像，不写回宿主登录文件。镜像不进入项目数据、备份、恢复或开源分发。`codex-native-login` 使用原生 Codex 根目录，认证刷新和会话写入由 CLI 完成；系统仍监管进程、超时、退出和任务结果。

Codex PR 评审使用按次授权的只读 MCP 工具，读取固定 Head/Base 的完整变更清单、差异和相关源码。原生模式也允许 CLI 在只读沙箱中通过自身工具读取已落盘的任务材料；提示词预览长度不构成代码读取上限。原生只读沙箱限制写入，不隔离该服务账号可读取的本机文件；选择原生模式意味着信任该账号下的 CLI 读取能力。自动调用忽略宿主 Codex 用户配置、execpolicy `.rules` 和自定义工具接入；原生模式也关闭自动注入宿主 `AGENTS.md`。代码修改和测试仍由现有受控执行器完成；本次接入没有开放原生 CLI 任意写代码、运行构建和发布的完整工具循环。

CLI 返回的判断仍按不可信输入校验；选择登录模式不会增加岗位、代码或 GitHub 权限。代码修改和 GitHub 写入继续经过原有策略、受控执行器及发布链路。普通流程逐项确认；已启用的自动 Review 和自有 PR 修复按各自范围免逐项确认，发布、Assign 和 Unassign 都由系统执行。超时、取消、输出越界、异常退出或无效结果结束本次尝试，不在同一任务修订上盲目重试。远程模型调用可能产生供应商费用；具体计费和数据保留规则由供应商决定。

每个岗位的 `brain` 负责日常巡查、摘要和低风险判断；可选的 `taskBrain` 专门处理已分派的 PR、代码或其他高风险任务。真实 PR 的冲突处理、代码修改、Review 和 CI 诊断会选择岗位明确配置的高能力 `taskBrain`；缺少该配置、凭据引用或代码出机授权时，任务等待所有者处理，不会偷偷降级到日常 Ollama。更换任一大脑只改变推理质量，不会增加岗位、代码或 GitHub 权限。

远程地址必须使用 HTTPS。需求、代码和记忆三类数据分别默认拒绝出机；只有岗位的 `remoteData` 对应分类显式为 `true` 时才允许发送。页面持续显示岗位实际使用的 Provider、模型以及是否为远程大脑。旧 PR 员工的正文、文件名和 diff 仍默认只允许发送到 loopback Ollama；它的远程代码授权继续由 `employees.prReviewer.allowRemoteCodeContext` 单独控制。

## GitHub 外部动作确认

GitHub 写入默认关闭。可以按动作分别启用 PR comment、Review、update branch、受控 commit push 和 merge。每项动作都绑定观察账号、base/head 仓库与 ref、精确 Head OID、事件来源和证据；同一 PR 的 Head 或来源发生变化会使旧结论和确认失效。push 只接受系统已经验证的受控 commit 证据，不接受浏览器或模型提供 ref、路径或提交对象。

普通外部动作进入统一的逐项确认弹框，展示账号、目标、Head、动作、完整正文和依据；浏览器只提交队列修订号与内容摘要，不能覆盖服务端保存的动作。已启用的 `automaticReview`、`assignAfterAutomaticReview` 和 `automaticOwnPrRepair` 在各自授权范围内自动处理，结果可在确认历史和工作台账追踪。自动模式不授权自动合并或关闭 Issue。点击“稍后”不会产生写入。外部结果不确定时会阻塞重复动作，重启后先只读对账；无法安全证明的结果保持 `unknown`，不会猜测成功或重复提交。

账号和凭据只配置在本机。推荐使用 `credentialMode: "gh-login"` 代理运行 MyDashboard 的同一 Windows 用户的 GitHub CLI 当前登录；系统不直接解析、复制或持久化 `hosts.yml`，固定的 `gh.exe` 会代表 MyDashboard 从同一用户的默认 GitHub CLI profile 读取当前登录，页面不能指定 `GH_CONFIG_DIR`。先在该用户会话中执行 `gh auth login --hostname github.com`，再在“配置”页面创建版本、核对影响并逐项确认激活。首次导入前也可在 `config.local.json` 使用同一结构：

```json
{
  "githubActions": {
    "enabled": true,
    "credentialMode": "gh-login",
    "enabledActions": ["comment", "review"],
    "actorAccountId": "用于发布 Review 的 GitHub 登录名",
    "ghCommand": "<GitHub CLI 的绝对可执行文件路径>"
  }
}
```

`gh-login` 只会在已经授权的动作执行或结果对账边界，由固定的 `gh.exe` 运行 `gh auth token --hostname github.com --user <actorAccountId>`；短期 Token 仅进入受限内存租约和对应 GitHub 传输，不写配置、台账、日志、页面、模型上下文、备份或验收产物，结束后清理引用。登录缺失、账号不一致、命令超时、输出异常或清理失败都会在任何写入前关闭失败。

兼容模式 `credentialMode: "token-env"` 仍可显式配置 `tokenEnv: "MYDASHBOARD_GITHUB_TOKEN"`，系统不会在两种模式之间静默切换。此时在启动服务的用户环境中设置专用最小权限 Token，再重启服务；配置仍只保存环境变量名。若确实需要代理或自定义 CA，必须在 `githubActions.networkEnv` 中逐项显式配置，因为携带 Token 的网络链路会随之改变。凭据来源不会改变逐项确认或明确启用的自动模式范围。

确认队列先持久化意图，再允许外部调用；进程崩溃后会先对账再恢复。同一 Head 下若职责、下一动作或岗位策略已经变化，原岗位会先持久化失效旧确认，旧 Review 不能继续执行；结果未知时，同一 PR 的后续动作会保持阻塞，避免重复发布。启动、定时刷新、手动刷新和本地 PR 事实变更都会先关闭确认入口，只有 GitHub PR 数据健康且岗位复核完成后才重新开放。Windows 上使用 named pipe 保证同一时刻只有一个外部动作写入进程；服务关闭会先停止定时工作并等待运行时释放，崩溃时句柄由操作系统回收。

## 可配置工作流路由

GitHub PR 和 Issue 的首次观察、创建、更新、分类、状态变化、完成及离开当前范围都会转换成只包含安全事实的本地事件。刷新成功后，系统按照当前活动配置版本中的 `workflowRouting` 整份规则定义进行分派，并保留事件、配置版本、分派结果和完整匹配解释。

规则按优先级从高到低判断；同优先级保持配置顺序。普通规则均未命中时才使用兜底规则。目标可以是岗位（`role`）、具体人员（`person`）或后续流程节点（`node`）；节点路由有静态环路检查、运行时已访问节点检查和最大跳数限制。当前默认把 PR 事件交给 `pr-engineer`，Issue 事件交给 `requirements-analyst`，其他事项回到本人分诊。

页面“工作流”视图可读取当前版本、规则、最新分派和审计解释，也可以用候选事件做不落盘试跑。修改规则、岗位、大脑和权限时，在“配置”页面使用结构化表单创建草稿、校验和预览影响，再由统一确认弹框激活；HTTP 不提供直接替换活动规则或 dispatch 的旁路。路由只回答“交给谁”，不会调用 GitHub、受控代码执行器或确认队列；后续动作仍核验对应的确认或已激活的自动授权。

路由状态采用进程级单写者和单调快照检查点。事件、配置、分派与审计通过内容摘要互相绑定，恢复时会拒绝回滚、分叉和损坏引用；保留策略只按完整事件包淘汰。持久化总量限制为 32 MiB，单个事件包和单条审计也有独立上限，避免异常输入无限占用本机资源。

“创建共享工作”表单是所有者把新事项交给指挥中枢的生产入口。浏览器只提交类型、优先级、标题、说明和验收条件，不能指定岗位、节点、权限或内部标识；服务端将可信的所有者请求转换为工作流事件，并以不可被普通规则覆盖的系统规则交给 `orchestrator`。请求 ID 在失败重试时保持不变，路由、分派和台账写入均可恢复并去重；创建结果及其内容寻址审计只保存在本机。

## 主动工作循环与统一请示

路由分派会可靠写入本地工作台账。员工按租约领取工作，生成严格结构化的判断和意图，再由可信策略决定它可以咨询用户、等待条件、转交岗位、完成工作，还是进入受控的代码/外部动作边界。模型看不到台账租约凭据或 GitHub 写凭据；原生 CLI 的只读工具不扩大代码写入和发布权限。

后台顺序固定为：事实刷新、工作流路由、分派 intake、回答回流、条件唤醒、岗位判断和意图分发。工作项的领取、判断、请示、回答、等待、重试、移交和完成都有本地时间线。页面“工作台账”默认把最近工作和最近审计放在上面；对应 HTTP 只有摘要、工作项和时间线三个只读查询接口。

员工需要你决定时，会进入与 GitHub 外部动作共用的唯一弹框。每次只展示一项；回答必须带当前 revision 和内容摘要，旧页面不能覆盖已经变化的问题。“稍后”不会改变工作或执行动作。内部答复只写本地请示箱，随后由主动循环对账并继续；它不会直接执行代码或写入 GitHub。

第 6 阶段已经把五个新岗位接入主动循环和可替换大脑。相同岗位的重复定时信号会合并，事实刷新优先淘汰过期定时 tick；用户手动运行保持有界、保序，并且不会在刷新竞争中静默丢失。所有岗位目前默认暂停，先由你检查路由、权限和模型后再逐个启用。

PR Review 提案已有持久化 runner、岗位与提案类型双重权限范围，以及固定账号/仓库/PR/Head 的授权计划。GitHub 写入关闭时不会发布；开启后按 `automaticReview` 决定自动发布或逐项确认。普通开发和测试提案在用户确认精确授权后创建持久化 Code Job，由恢复优先的 worker 驱动受控工具循环；应用变更包另行确认。启用 `automaticOwnPrRepair` 后，符合范围的自有 PR 修复可自动创建隔离任务、执行已配置验证并推送原 PR，无需逐项确认，不应用到用户当前工作区，也不自动合并。

## 本地记忆与可引用回答

“记忆”页面的关键词、岗位、仓库、事件类型和时间筛选完全使用本地索引，即使 Ollama 和第三方模型均不可用仍可搜索。页面也可以向当前筛选范围提问：服务先读取完整的本地权威记录，再让所选大脑返回结构化结论；每条结论必须引用当前有效的原始记录，派生记录和已被替代的记录不能单独支撑结论。回答会展示 Provider、模型、本地/远程状态、上下文摘要和完整引用，也可以用同一批记录和摘要切换到本地模型复现。

岗位也可以获得主动查证能力：只有在该岗位的 `permissions.allowedIntents` 显式加入 `query_memory`，并且统一记忆及带引用问答均已启用时，员工才能请求一次与当前任务修订绑定的记忆查询。系统先持久化查询预约，再调用选定大脑；结果必须引用仍然可访问的原始记录，随后才回到同一轮岗位判断。崩溃后不能证明结果的查询保持未知且不会重复调用模型。远程岗位要读取查询结果时还必须单独允许 `remoteData.memory`。

默认回答大脑与本地复现大脑都是 `ollama / qwen3.5:9b`。可在 `memory.answering.brain` 中选择第三方 Provider，在 `memory.answering.localBrain` 中保留本地 Provider。远程调用仍受 `requirements`、`code`、`memory` 三类数据授权约束；任何一类未明确允许都会在发送请求前拒绝。并发回答默认限制为一个，避免本机推理任务堆积。

Git 提交和本地会话导入默认关闭。需要时只在不入库的 `config.local.json` 显式开启：

```json
{
  "memory": {
    "imports": {
      "localSessions": true,
      "git": true
    }
  }
}
```

启用后，本地同源调用方可分别使用 `POST /api/memory/import/session` 和 `POST /api/memory/import/git`。导入只接受有界结构化数据，不接受文件路径、命令或工具权限；重复导入按内容寻址去重。会话、工具输出、HTML 和提交信息始终作为不可信文本保存，不会被执行。本项目不读取、不启用也不依赖 `claude-mem`。

## 受控代码执行器

代码执行基础能力默认关闭，原始执行器、Code Job 生产端口和 worker 均不向 HTTP 暴露。启用后，开发、测试岗位也只能通过已封存的授权创建 Code Job；worker 会在每次大脑调用和新动作入场前重新核验授权，只能调用固定语义工具，并在隔离工作区内执行。启动时会先恢复持久化任务和执行器会话；恢复校验失败会直接阻止服务开放，不会退回宿主机命令执行。暂停中的已入场动作和结果未知动作只允许可信对账，不会再次询问模型或重复执行。

私人工作区和 Docker 设置只保存在不入库的首次导入配置或本机版本化配置数据中。已有活动版本时从“配置”页面创建草稿并逐项确认，不能靠修改启动文件绕过影响预览。下面是本项目在 Windows Docker Desktop 上的首次导入示例；镜像必须固定到 digest，工作区写权限必须逐项列出：

```json
{
  "codeExecutor": {
    "enabled": true,
    "docker": {
      "executable": "<Docker CLI 的绝对可执行文件路径>",
      "host": "npipe:////./pipe/dockerDesktopLinuxEngine"
    },
    "gitCommand": "<Git 实现的绝对可执行文件路径>",
    "gitTimeoutMs": 30000,
    "workspaces": [
      {
        "id": "dev-intelligence-hub",
        "sourceRoot": ".",
        "gitHeadSnapshot": true,
        "writablePaths": ["src", "test"]
      }
    ],
    "profiles": {
      "node-tests": {
        "kind": "node-test",
        "image": "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
        "timeoutMs": 30000
      },
      "repository-contract": {
        "kind": "node-script",
        "image": "node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
        "timeoutMs": 30000,
        "asset": {
          "schemaVersion": 1,
          "title": "仓库契约冒烟测试",
          "description": "跨 PR 复用，验证仓库必须保留的目录和清单。",
          "version": 1,
          "source": "import { access } from 'node:fs/promises';\nawait access('/workspace/src');\nconsole.log('repository contract passed');"
        }
      }
    },
    "requiredProfilesByWorkspace": {
      "dev-intelligence-hub": ["node-tests", "repository-contract"]
    }
  }
}
```

临时工作副本和不可变审计产物保存在被 Git 忽略的 `data/code-executor/`。源仓库保持只读；员工只能提交固定语义动作，不能传入任意 shell 命令。

“自动化测试库”页面展示活动配置中的可复用脚本、资产版本、固定镜像、绑定工作区和自动复用仓库。脚本由配置草稿管理，激活时经过影响确认；正文、版本和运行边界一起进入配置摘要。把脚本 Profile 加入 `requiredProfilesByWorkspace` 后，相关仓库的开发和测试 Code Job 在完成前必须通过该脚本，结果、标准输出、标准错误、镜像 ID、Profile 摘要和工作区 revision 会进入受控执行证据。更新脚本时必须递增 `asset.version`，再激活配置；已经发出的任务仍绑定原来的配置摘要，不会静默改用新脚本。

测试库脚本目前使用固定的 `node-script` 运行器：宿主机只物化已经激活的脚本文本，Docker 以无网络、只读仓库、只读脚本、无 Linux capability 和固定资源限制运行。模型不能提供命令、镜像或脚本文本。需要 Vitest、Playwright、编译器等工具时，应先制作包含依赖的专用镜像并固定到 digest；不要在脚本中联网安装依赖。Windows/Qt/FastBuild 不能在 Linux Docker 运行，因此这类 Profile 必须等待受控 Windows 沙箱能力，不能退回到不受控的宿主机 PowerShell。

PR 绑定任务启用 `gitHeadSnapshot` 后只会从已确认的 Git commit 对象生成执行副本，不读取当前 checkout 的脏文件，也不会运行 hook、filter 或网络拉取。Windows 必须把 `gitCommand` 直接指向 Git for Windows 的实际实现（通常位于 `mingw64\bin\git.exe`），不能使用 `cmd\git.exe` 或安装目录下的分发包装器；程序路径、内容摘要和大小都会随工作区权限一起封存。该能力只接受本地普通仓库的真实 `.git` 目录，不接受 UNC、linked worktree、alternate/partial object store 或对象链接。

## 本地安全边界

服务只监听 `127.0.0.1`，校验 Host、同源写请求并禁止页面被其他站点嵌入。它是单用户本地工具，当前信任同一台机器上能够访问 loopback 的本地进程；不要把 4173 端口代理或暴露到局域网/公网。

## 通知规则

- 第一次运行只建立基线，不发通知。
- 仅新增事项或关键状态变化参与通知。
- 仅优先级不低于 80 的变化发送钉钉消息。
- 每次最多 5 项，不重复播报静止状态。
- 钉钉定时汇报按 Asia/Shanghai 时间运行：09:00 发送每日总览，12:00、15:00、18:00 发送阶段进展，20:00 发送今日收口。
- 每个时间档先持久记录再发送；服务重启或刷新重叠时不会重复发送同一档汇报。最新汇报同时显示在“钉钉中的行动信号”页面。

`config.example.json`、`config.json` 和 `config.local.json` 只负责首次安全导入；活动配置版本保存在本机 `data/` 中，并通过“配置”页面的草稿、确认、回滚和审计管理。私人文件均不入库。

## 定时任务

- `MyDashboardServer`：登录时启动本地网页服务。
- `ClaudePRChatDigest`：保留原任务名以完成平滑迁移，每小时调用 `scripts\Refresh-And-Notify.ps1`；脚本只让常驻服务执行带通知刷新，服务不可用时记录失败并等待下次调度，不启动第二个写进程。

任务切换后不再调用 Claude CLI；`ClaudePRChatDigest` 的数据源和增量通知语义已内建于本项目。

`npm run refresh` 是服务停止时使用的独立维护命令；常驻服务运行期间请使用页面“刷新”或本地 `/api/refresh`，保持单写者。

## 许可证

Development Intelligence Hub 使用 [Apache-2.0](LICENSE) 许可证。
