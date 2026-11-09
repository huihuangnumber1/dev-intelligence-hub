# agent-feishu-bridge 源码核查与接入方案

> 2026-10-14 复核：上游仍为下述提交。第 5、7 节保留的是当时的接入状态，
> 已不能用作当前源码能力说明。当前 Windows 原生路线已接入 App Server、实时引导
> 及单轮连续受控开发，详见[架构](../ARCHITECTURE.md)和
> [验证记录](../validation/2026-10-14-continuous-codex-development.md)。
> 本轮借鉴其完整 turn、事件和 steer 方式，没有复制上游源码；原生进程与受控动作
> 都确认结束后才确认停止，也不采用清空界面状态代替后台停止的做法。

核查日期：2026-10-13。固定上游提交：`869fd69e27384040019fbf69505a336151ed9159`。

本次追踪了 Codex 传输、消息派发、线程恢复、运行事件、停止、异常恢复、状态保存及相应测试。阅读的是源码和测试断言；没有安装或执行上游项目，没有验证它在本机真实 Codex 服务上的行为。

## 1. 它实际怎样调用 Codex

`rpc-client.js` 启动长期运行的 `codex app-server`，或者连接已有 WebSocket endpoint。标准输入输出传 JSON 消息；请求带 ID，`pending` 表匹配响应，通知走事件监听器。建立连接后发送 `initialize` 和 `initialized`。RPC 请求的响应超时与整个模型任务的运行时间是不同概念。

线程层负责 `thread/start`、`thread/resume`，消息层负责 `turn/start`。运行中追加内容调用 `turn/steer`，参数包含 `threadId`、`expectedTurnId`、文本或本地图片输入，以及可选的消息标识。因此它确实可以向当前回合提交补充内容，不需要先完成当前回合再执行第二次 `exec`。

来源：[Codex RPC 客户端](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/src/infra/codex/rpc-client.js)、[线程服务](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/src/domain/thread/thread-service.js)。

## 2. 微调如何避免串到其他任务

`dispatcher.js` 识别当前线程是否有活跃回合。配置为 `steer` 时，同线程补充消息排队发送；入队时捕获回合 ID，真正发送前重新核对。回合已经结束或切换，不能把这条消息静默送进新回合。成功回复表示 RPC 已接受提交，不能证明模型已经完成按新要求执行。

待审批时先处理审批，不直接追加。上游还明确处理不可引导的阶段，例如相关 `/review` 或压缩阶段报错。我们的界面需要显示“已提交到当前回合”“等待安全检查点”“未送达”，不能统一写“已生效”。

来源：[消息派发和 steerActiveTurn](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/src/app/dispatcher.js)、[微调测试](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/scripts/test-active-turn-steer.js)。该测试覆盖请求参数、同线程串行和 reject 模式；不能据此宣称所有断线、重复提交与真实模型场景均已验证。

## 3. 为什么它能显示正在做什么

运行状态由 `turn/started`、任务项开始/完成、命令输出、工具进度、计划更新和终态等事件更新。它分别维护活跃回合、开始时间及最近活动时间；不是只根据一次调度请求把岗位永久标为运行中。

迟到的旧回合终态会在事件入口被拒绝。异步投递结果后再次核对回合，避免旧任务的完成回执清掉新任务。工具记录只展示最近几条，避免卡片不断膨胀。

来源：[事件服务](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/src/app/codex-event-service.js)、[消息状态映射](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/src/infra/codex/message-utils.js)。

## 4. 恢复机制中哪些不能照搬

| 上游行为 | 本项目处理要求 |
| --- | --- |
| 按最近实际活动判断是否长期无响应；等待异步清理后再次核对活动 | 借鉴活动时间与二次核对；长任务有进度时不能仅因总时长过长就判死 |
| 看门狗释放飞书界面占用，提示终端任务可能仍在运行 | 显示“执行状态未知”，核对进程与执行器；不能当作任务停止证明 |
| `turn/interrupt` 报错也清除界面运行状态 | 暂停或取消必须区分“请求已发送”和“停止已确认”；未知时禁止重放写操作 |
| 特定线程恢复错误会清除绑定并新建线程 | 本项目保留原绑定及历史；自动开发任务不能静默丢失上下文后继续 |
| SessionStore 原子替换、保留备份，并检测外部修改 | 借鉴备份与写失败回滚；源码自己说明外部修改检测不是跨进程锁 |

来源：[看门狗](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/src/app/feishu-bot-runtime.js)、[停止与终态](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/src/app/codex-event-service.js)、[会话保存](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/src/infra/storage/session-store.js)。上述限制是针对自动开发和 GitHub 写入场景的工程判断，不代表已复现上游生产事故。

## 5. 对本项目的具体调整

当前原生路线仍是 `codex exec --json` 加实体线程 `resume`。执行器一次提交输入后关闭 stdin，不能把网页文本框接上去就称作实时微调。

| 层次 | 要实现的行为 |
| --- | --- |
| Codex 适配器 | 增加可选 app-server 通道，支持开始、恢复、事件订阅、当前回合引导、中断及状态核对；继续使用原 Codex 登录与会话目录 |
| 运行登记 | 将真实执行绑定到工作项、岗位、线程和回合；记录最近进度、补充要求回执，旧回合事件不能更改新任务 |
| 网页运行列表 | 展示正在执行、等待停止确认、已暂停；点击查看简短工具进度、任务详情和补充要求 |
| 任务控制 | 补充要求优先使用实时引导；不支持时明确标注检查点续接。优先级影响后续调度；暂停、取消需要结算执行状态 |
| 派发与发布 | 微调不会扩大文件或工具权限；“先别发布”必须在 GitHub 写入前检查，已经发布的结果不能靠文字指令撤销 |

适配器按实际能力声明支持的操作，避免把具体 CLI 版本号写死为项目门槛。旧路线保留检查点续接能力作为兼容方案。该表为接入设计，**不表示 app-server 通道或网页运行列表已经上线**。

## 6. 验证要求

- 当前回合结束与追加要求同时发生时，指令不得串到下一任务。
- 同一线程连续补充要求有序；重复 HTTP 提交不会重复执行。
- 旧回合完成事件、重连事件和停止回执不会清理新回合。
- 长任务持续有工具进度时不会被误判超时；无实际进度不能靠心跳无限续期。
- 中断响应超时或连接断开时保留未知状态，核实前不重放发布或写文件动作。
- CLI 不支持实时引导时，界面明确显示兼容行为与实际生效时机。
- 暂停和补充要求在服务重启后保留，且原授权、固定测试与 PR Head 校验仍有效。

## 7. 使用边界与当前交付状态

上游使用自定义协议，商业用途条款包含公司内部产生商业收益的场景，并要求书面授权。本项目只参考协议使用方式和设计思路，独立实现，不复制上游代码。来源：[上游 LICENSE](https://github.com/Jokerautowrite/agent-feishu-bridge/blob/869fd69e27384040019fbf69505a336151ed9159/LICENSE)。

源码核查后的实现已接入：运行登记、全局网页列表、受信任 HTTP 控制、岗位判断与受控代码动作。真实台账暂停/恢复/取消、模拟 CLI 的实际 stdio 通信和隔离 Chromium 交互均有聚焦验证。app-server 协议适配已有测试；本机真实 CLI 初始化成功，但拒绝必要的配置隔离参数，双向进程树监管也尚未验收，因此生产实时通道在启动前明确返回不可用，默认继续使用 exec 检查点续接。使用方式见用户手册和运维手册。没有执行上游项目的测试；这些验证不代表已部署，也不代表真实业务 PR 已完成评审。

后续集成的 `settleControl` 回调必须幂等，并读取当前台账与执行器状态；暂停前保存的工作项修订号不能直接用作恢复时的修订号。持久化或结算失败时，登记器保留待核对状态，调用方不能据此宣称任务已经停止。

现有配置、任务和 Codex 会话未迁移。接入工作按上面的实时能力方案继续，不能以基础模块测试通过代替全系统可用验证。
