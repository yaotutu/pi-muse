# 架构规范与新能力接入

本项目是单进程、单用户、单业务模型、单一助手身份的模块化单体。公开会话是隔离聊天上下文的单位，不是独立助手身份。代码实现、模拟回归、真实模型、页面与原生客户端验收分别报告，不把源码更新当作部署或发布。

## 功能迭代基线

新入口复用同一套文字会话接口，统一以 `sessionId` 选择上下文。接入渠道只负责输入输出；语音转写、设备事件转成文字等留在调用方。主会话是默认入口，也是用户显式保留任务时的接收会话。

新增能力先按下列归属落到已有层，再检查停止、重试、重启和多端回读。

| 能力 | 归属与接入方式 |
| --- | --- |
| 当轮委派 | 沿用父轮的会话、权限与取消边界，结果回父轮 |
| 定时任务或独立检测 | 使用自身业务仓库记录状态与接收会话；投递沿用该会话的运行或通知入口 |
| 后台内容领域 | 以独立规则、存储和提示词注册到领域注册表；协作工具只暴露明确的读、写与查询接口 |
| 助手偏好 | 写入对应全局配置 owner；所有普通会话下一轮读取同一事实 |
| 客户端界面 | 业务写入走 REST，聊天流归会话，通知流归连接；结果未明先回读，再决定下一步 |

## 职责边界

| 位置 | 职责 |
| --- | --- |
| `src/index.ts` | 配置、监听、信号退出 |
| `src/bootstrap/create-service.ts` | 唯一 repository、服务、模型 runtime、调度器和关闭流程 |
| `src/features/` | 领域规则与最小 ports，不依赖 Hono、pi SDK 或具体文件系统 adapter |
| `src/adapters/pi/` | SDK 装配、执行事件、历史投影、受控工具与错误脱敏 |
| `src/adapters/storage/` | 路径布局、校验、原子文件写入和串行读改写 |
| `src/http/` | 薄路由、鉴权、契约、presenter 与自动文档 |
| `web/` | 同仓库接口联调台，不是原生移动产品 |

使用函数式工厂和显式依赖注入，不引入厚重 DI、通用事件总线或第二套执行循环。相同业务文档必须共用一个 repository 和写队列。依赖方向由 `tests/unit/dependencies.test.ts` 检查。

## 状态所有权

- 实例全局：模型配置、SOUL/USER、长期记忆、目标、助手指令、技能资产及开关、浏览器、新闻、短信、Dream 和唯一工作区。
- 公开会话：元数据、pi JSONL、消息反馈，以及任务/监控/审批/活动的来源归属。
- 单次运行：active run、取消信号、临时工具装配与当轮审批授权。新运行不能继承旧审批。
- 客户端：服务器地址、Session Token 与本地 UI 草稿；不保存模型 Key，也不是业务事实来源。

pi `createAgentSession` 是执行循环唯一实现；`SessionManager`/JSONL 是正文、附件与工具事实唯一权威。业务反馈、信息条目、任务状态不是第二份聊天历史。

## 会话与执行生命周期

`main` 首次启动创建、永久常驻、标题固定为“默认会话”，不可删除，可重置。专题会话由服务端生成 UUID，缺省标题“新会话”。列表中 main 第一，其余按更新时间倒序。公开 `sessionId` 与内部 `piSessionId` 始终区分。

`SessionHub` 每个公开会话只缓存一个协调器，初始化 Promise 也缓存。短生命周期锁串行协调任务来源绑定、重置与删除；运行锁只属于该会话。不同会话上下文独立，可并行运行。缓存回收只处理闲置且无运行/引用的专题会话；main 不回收。

- 读取、迟到 Stop 或删除后的请求不得创建或复活会话。
- reset 取消运行/审批、清空 JSONL 与消息反馈、生成新 pi 身份；保留公开 id、标题、定时任务、监控与全局助手配置。
- 删除专题会话前确认任务清单。持久化删除意图后关闭旧引用，清理目录与反馈，并按选项删除任务和监控或转到 main；部分完成的删除在启动时恢复。
- 取消不回滚已完成副作用；写入结果未明先读取状态，不自动重放业务操作。

## 提示词与技能

所有静态系统提示词统一托管在仓库根目录 `prompts/`（全英文模板 + 中文索引 `prompts/README.md`；源码模式直读磁盘，构建时同步至 `dist/prompts/`；不做数据目录覆盖）。所有 Agent 统一遵循「系统提示词（`prompts/`） + 用户 `INSTRUCTIONS.md`（与通用已归纳长期习惯） + 当次 `UNTRUSTED INPUT DATA`（含未消化反馈热缓冲）」三层拼装。

主对话每轮装配顺序是 `prompts/assistant/base.md`、本轮实际工具说明（`prompts/assistant/tools/*.md` 及主聊天开放路由的专职 Subagent 清单 `prompts/assistant/subagents.md`）、SOUL、USER、共享助手 `workspace/assistant/INSTRUCTIONS.md`、memory 检索说明。助手指令在各聊天会话每轮重读，不能扩大工具权限。短信与新闻专职 Subagent 各自读取本领域 `INSTRUCTIONS.md`。全部 5 份工作区托管文档（`workspace/assistant/{SOUL,USER,INSTRUCTIONS}.md` 与 `workspace/domains/{sms,news}/INSTRUCTIONS.md`）均支持在文件最顶部使用 YAML Frontmatter `include:` 引用 `workspace/` 内相对路径的纯文本文件（读写 API 保持原文不拍平，并在 `/api/assistant/instructions`、`/api/information/preferences`、`/api/news/preferences` 与 `/api/subagents/:id` 附带只读 `includes` 诊断数组；注入模型前按当前文件所在目录实时展开，最多 5 层嵌套与 60,000 字符上限，环路/重复自动去重，缺失或越界静默跳过；AI 归纳习惯绝不解析 `include:`）。

技能资产全局共用，开关全局保存并绑定 `source/name`；默认值只来自随服务端发布的内置清单 `assets/skills-defaults.json`，通用与自建来源一律默认关闭，最终装配以手动选择优先。目录优先级为实例 `DATA_DIR/skills/` > 内置技能 > 服务端用户 `~/.agents/skills/`，来源在目录、维护视图和 HTTP 清单中一致；关闭不回退，同名新来源不继承旧选择。复用 pi loader 解析标准 SKILL.md，不写私有技能 config，也不发现个人 CLI 的其他配置、扩展或凭据。通用技能目录只读，入口链接规范化为真实技能根，内部链接与超限正文拒绝；共享脚本/extension.ts 不执行。自有可信扩展仍是服务端代码，路径 guard 不是操作系统沙箱。只有本轮启用技能的精确 SKILL.md 与支持的文本资源可作为 read 的额外只读例外；不扩大目录、代码或配置访问。专职 Subagent 默认零继承主聊天技能，只加载自身静态绑定的能力。

## 统一 Subagent 架构与只读检视

全仓统一为**「唯一底层执行内核 + 唯一上层专职 Subagent 注册中心」**，不再并存动态聊天角色文件与独立 `domain_agent` 目录：

- **底层唯一内核（`src/adapters/pi/subagent-runner.ts`）**：`runSubagent` 与结构化薄封装 `runStructuredSubagent` 坚持默认零权限（Deny-by-default），每次执行创建独立 `SessionManager.inMemory`，纯函数语义（无跨次聊天上下文，仅在单次执行周期内持有独立内存会话记录），不落盘、不创建会话目录、不发现个人 CLI 资源，硬拦截 `bash` 与递归 `subagent`，统一管理超时、`AbortSignal` 取消、错误脱敏、`modelTrace` 与资源释放。
- **上层统一注册中心（`src/features/subagents/` + `src/adapters/pi/subagents/catalog.ts`）**：所有专职 Subagent 提前静态声明自身提示词、工具、技能与 MCP（预留槽位），集中注册在 `create-service.ts`，当前内置 5 个专职 Subagent：
  - `sms`（`chat` + `background`）：后台实时/归档/简报筛选 + 主聊天路由查短信与修改 `workspace/domains/sms/INSTRUCTIONS.md`（经父会话版本绑定人工审批）。
  - `news`（`chat` + `background`）：后台 RSS 筛选 + 主聊天路由查新闻与修改 `workspace/domains/news/INSTRUCTIONS.md`（经父会话版本绑定人工审批）。
  - `browser`（`chat`，`parallelAllowed: false`）：独占共享真实 GUI Chrome，执行多步网页浏览、交互与信息提取，遇登录或验证码发起人工接管；在 `parallel` 模式下直接拒绝以防抢占同一桌面窗口。
  - `habits`（`background`）：后台定期归纳各领域未消化用户反馈样本为长期行为习惯。
  - `dream`（`background`）：后台定期整理主会话增量消息并提出笔记变更提案。
- **主聊天统一路由**：主聊天默认开放 `subagent` 工具（支持 `single` / `parallel` / `chain`、`{previous}` 占位、最多 8 项 / 4 并发），按已启用 `chat` Subagent 清单直接路由专职任务，不再维护旧编程风角色（`scout / planner / reviewer / worker`）或独立 `domain_agent` 工具。父 Stop、断流、超时和关闭传播取消并等待子执行收尾，失败不自动重试。
- **前端只读检视契约**：提供鉴权只读端点 `GET /api/subagents` 与 `GET /api/subagents/:id`，完整暴露全部已注册 Subagent 的触发模式、启用状态、纯函数执行策略、内置提示词原文、关联用户指令/习惯快照、静态绑定的工具/技能/MCP 槽位以及各维度可编辑性元信息。

## 消息与反馈

正文和消息身份来自 pi branch；展示读取完整权威历史，不用压缩摘要替换 UI 历史。图片附件从同一条 pi user message 的 image blocks 恢复，文本附件作为不可信数据进入该条请求，不创建工作区附件库。

反馈绑定公开会话、pi 会话和消息 id，在 `main.sqlite` 独立记录原始反应/收藏（`saved`）/评论事件并同步索引状态视图，不追加到 JSONL、不改变聊天 revision。喜欢/不喜欢互斥且可撤销，收藏可独立开关，评论 trim 后 1–4000 字符；支持按 `saved` 与 `reaction` 条件查询消息反馈列表（`GET /api/sessions/:sessionId/messages/feedback`）。当前生成消息和工具结果不可反馈。reset 与删除会话清理对应反馈；旧 pi 身份返回冲突，不把反馈迁移到新历史。底层统一记录全部行为事件，具体下游业务可按需消费（当前信息偏好从通知反馈提取 reaction/saved/comments 样本）。

## 领域业务与通用习惯引擎（短信、新闻、Dream）

短信与新闻业务模块持有各自的持久化数据、用户指令文件 `workspace/domains/<id>/INSTRUCTIONS.md` 与通用行为习惯引擎；AI 执行与主聊天交互统一由对应的 `sms` / `news` 专职 Subagent 承载：

- **指令写入**：设置页与工作区文件页共享各领域的 `workspace/domains/<id>/INSTRUCTIONS.md` 原文（字段名统一为 `instructions`）。主聊天路由至 `sms` / `news` Subagent 修改规则时，透传父会话工作区文件版本绑定审批。
- **后台技能彻底剥离**：聊天 `SKILL.md` 与全局技能开关只服务主聊天会话；后台 Subagent 绝不注入主聊天技能、也不读取 `workspace/assistant/INSTRUCTIONS.md` 或全局 `memory.md`，只依赖仓库 `prompts/` 中各自的系统提示词、独立用户 `INSTRUCTIONS.md` 与通用习惯引擎维护的长期习惯条目及未消化反馈热缓冲。
- **通用习惯定期归纳与热缓冲（`src/features/habits/`）**：跨领域管理长期行为习惯（`habit_items`，每领域上限 50 条、每条 `<= 300` 字、支持用户手动通过 `/api/habits/:domain` 增删改且不写用户 `INSTRUCTIONS.md`；`GET /api/habits` 列举全部已注册领域摘要，`GET /api/habits/:domain` 附带 `name`、`summary` 与活跃待归纳 `pendingSignals` 明细）与按递增 `seq` 游标追踪的原始反馈热缓冲（`habit_signals`）。达到每领域 5 个去重活跃反馈目标、固定 2 小时周期或手动触发 `POST /api/habits/:domain/consolidate` 时，受限 `habit-runner` 增量输出 `add/edit/delete` 并在成功校验后原子推进 `cursorSeq` 与清理已消化样本；模型失败、取消或并发手工修改均受游标与乐观版本保护，绝不丢弃未消化反馈。未及归纳的近期反馈通过热缓冲即时进入下一轮领域推理，彻底避免仅截断保留最近 10 条导致的规则遗忘。
- **通知隔离与结构化引用**：重要后台通知携带显式 `domainId`（仅允许 `source === "notification"` 且存在 `notificationId`）写入 `main` 历史并发送失效通知，不额外启动一轮主聊天模型。`src/adapters/pi/domain-notification-context.ts` 默认将未被引用的领域通知卡片从主对话模型上下文剔除；用户通过移动端统一结构化格式 `【领域引用:<domainId>】...【引用结束】` 显式引用后，该卡片才进入当轮上下文。

短信是一条全局信息管线（`src/features/information/`），设置默认关闭，系统提示词采用默认静默（Default-Silent）基线与四级优先级（`用户 INSTRUCTIONS.md` > `近期未消化反馈热缓冲` > `已归纳长期习惯` > `默认静默基线`），严格分离两条通道并共享同一套用户指令（`workspace/domains/sms/INSTRUCTIONS.md`）与通用习惯引擎（`sms` 域）：1）日常实时单周期（`queue=realtime`）：接入后经 O(1) 索引查询到期或手动触发（`POST /api/information/runs` 支持 `{}` 或 `{ retryFailed: true }` 重试失败条目），单轮判定（`submit_information_result`）落库后直接推送主对话；多条目批次被上游内容安全审核（`MODEL_CONTENT_REJECTED`）拒绝时自动二分隔离，仅真正触发审核的条目失败，其余条目正常处理；2）历史批量归档（`queue=archive`）：通过 `/api/information/archive/*` 独立导入并显式运行，与实时调度彻底隔离，逐批向通用习惯库增量提交 `habitOperations`，多条目批次被上游内容安全审核（`MODEL_CONTENT_REJECTED`）拒绝时同样自动二分隔离毒丸条目；当归档队列 pending=0 且不再存在非审核类失败（瞬时故障、`INVALID_MODEL_RESULT` 等仍阻断并等待 `retryFailed`）时，通过 `submit_information_briefing` 至多推送 1 条 <= 1200 字简报，其中自然告知被审核跳过的条目数（`skippedCount`，不泄露内部字段名）。仓储层采用 `main.sqlite` `sms` v4 直接 SQL 定向查询/事务（含 `idx_sms_items_queue_status`、`idx_sms_items_accepted`、`idx_sms_runs_started`、`idx_sms_decisions_item` 四组索引），归档 run 的 `started_at`/`finished_at` 单调推进以保证波次边界确定性，列表/详情接口直接投影 `decision` 与 `reason`，并在每轮收尾按有界保留上限自动清理历史（始终保留待处理/运行中/失败条目）。专题会话不接收通知，silent 或失败不制造通知；disable/reset/shutdown 取消未落盘投递，已落盘通知不回滚。

新闻是完全独立的全局 RSS 采集与推荐筛选管线（`src/features/news/service.ts` 与 `src/features/news/screening.ts`），源、文章、反馈与推荐结果保存在独立的 `news.sqlite`（v3 已清理废弃列并有界保留最多 2,000 篇无反馈历史文章，含用户反馈的文章永不裁剪），彻底解耦短信管线与 `workspace/assistant/INSTRUCTIONS.md`；反馈变更同时向通用习惯引擎（`news` 域）写入热缓冲信号，筛选模型仅返回 `decisions`，长期偏好由通用习惯引擎定期提炼并回注筛选上下文。调度同样通过 O(1) SQL `hasPendingArticle()` 触发受限单轮模型。新闻服务与数据库工具复用同一 SQLite 连接及操作队列。RSS 通过安全网络 adapter 抓取，严格 XML/大小/深度/条数校验，拒绝 DTD/实体和可执行 HTML。推荐不写聊天，删除源保留文章与反馈，已归纳习惯不覆盖用户显式指令。

Dream 是实例全局服务：系统整理提示词与不可覆盖安全规则统一托管在仓库 `prompts/dream/`（无运行时数据目录覆盖），游标按来源会话在数据库保存，待决项全局管理。整理用受限内存 pi 轮；条件写入核对读取版本，不覆盖用户并发编辑；失败/部分成功不推进对应游标。来源已删除时不得借待决项重建会话。周期固定两小时，忙会话跳过，不自动重跑失败模型轮。

## 任务、监控与活动

jobs 和 monitors 的来源是公开会话；省略来源使用 main。只绑定已有会话，删除中的来源拒绝接纳。任务在所属会话运行真实 pi 轮，与其聊天共锁；状态保存失败仅补存同一次结果，不重跑工具。监控复用安全网络请求；返回的抓取只有仍匹配当前检测配置才可更新基线。待投递通知持久化后按当前归属投递，成功才确认。用户在任务运行中设置的新排期保留，上一轮只更新自身结果。

Activity 与真实步骤保存在对应会话 JSONL custom entries，不建立第二份活动历史。完成声明须本轮工具/子代理/审批结束且最终回复实际交付后才生效；Stop、错误、断流和崩溃如实保留终态。观察器不输出原始工具参数、思维、凭据或内部诊断。

## 文件工具与审批

唯一文件根是 DATA_DIR/workspace/，所有会话与子代理共用。相对目录名只作普通路径，不存在第二个根或前缀映射。拒绝绝对路径、父目录跳转、反斜杠、根/中间/目标符号链接；逐段 lstat 并复核物理边界，读普通文件使用 no-follow。递归查询不跟随链接。

模型永不获得 bash。write/edit/skills.save 每次登记完整 before/after、路径、文件版本、来源会话/运行与过期时间；拒绝、过期、取消或版本变化均不提交。批准只表示人的决定，不代表实际执行成功；执行回执独立推进 revision，崩溃未知状态不重放。

手动 HTTP 文件操作只在客户端完整展示并明确确认后提交，不生成模型审批，也不能绕过模型审批。所有入口共用逐物理路径提交队列；提交前重查版本/路径/取消/期限，临时文件原子替换，不截断旧文件。不是跨进程事务或防恶意外部竞争的操作系统沙箱。文件操作结果未明必须先回读。

## 数据布局与校验

路径唯一来源是 `src/adapters/storage/data-layout.ts`。唯一工作区 `workspace/` 保存全局 `assistant/{SOUL,USER,INSTRUCTIONS}.md`、`domains/{sms,news}/INSTRUCTIONS.md` 与 `files/`；全局状态目录 `state/assistant/` 保存 `memory.md`、`identity.json` 与 `skill-overrides.json`；`sessions/index.json` 与 `sessions/<sessionId>/history/` 保存各会话元数据与 JSONL；默认业务库 `state/main.sqlite` 保存定时任务、目标、审批记录、短信、通用用户习惯、Dream 与消息反馈行为数据，新闻使用独立 `state/news.sqlite`，网页监控暂留 `state/monitors.json`。存储边界与判据见 [SQLite 存储约定](sqlite-storage.md)。

SQLite 表和字段采用 snake_case，领域表以模块名前缀区分，迁移版本单独登记。新闻文章、反馈、评论、批次和决定关系化保存，不以整份 JSON 文档替代关系表。保持原始业务 ID、顺序、时间及删除语义；来源是历史快照的关联不应错误级联删除文章。数据库内更新使用短事务，不在 SQL 事务内等待模型、网络或人工决定。

`database` 是共享的业务数据工具，可自主查询、写入、建表、改列和删表，无库/表角色或逐次 SQL 审批；main/news 两个库均可操作。它不是任意文件或代码执行接口：库位置由宿主管理，不借 SQLite 扩展、外部文件附加或文件输出绕过工作区与文件审批边界。数据库结构被直接改坏时应如实失败，不自动重建成空库。同步 SQL 已执行/提交的副作用不因稍后取消而回滚，不宣称 AbortSignal 能中断任意正在运行的 SQLite 语句。

仅 ENOENT 可初始化默认值，损坏 JSON、非法字段、未知结构与其他 I/O 错误必须报错，不过滤坏条目或静默置空。文件写入使用同目录独占临时文件、受保护权限与 rename；单进程串行读改写。新布局不读取、转换、迁移或删除旧实例数据；正式实例处理另行授权。

SQLite 的连接所有权、模块命名、当前表语义与演进边界见 [SQLite 存储约定](sqlite-storage.md)。

## 助手形象

「助手形象」是实例全局的展示资产，不创建业务助手身份、不进入模型上下文，也不向模型装配修改工具。服务端入口由 `/docs` 的「助手形象」分组提供；客户端只消费鉴权接口，不能以图片 URL 泄露 Token。

`DATA_DIR/companions/<id>/` 保存可选 `manifest.json` 与八个固定状态 PNG；缺省清单使用目录 ID 作为名称。feature 持有类型、校验、完整性与版本规则，唯一服务队列串行所有读写；storage adapter 逐级 lstat 拒绝容器、包、清单和图片符号链接，no-follow 有界读取，原子替换有效文件。GET 不新建目录；坏清单、坏图和不完整包只进入 diagnostics，不静默删除或覆盖。允许 HTTP 分步保存元数据与图片，全部有效后才出现在可用列表；version 绑定规范化清单内容与八个 PNG 字节。用户显式 DELETE 才删除整个包，且拒绝包内链接。具体请求和错误从 contracts 自动生成，不另维护接口表。

## 外部网络、浏览器与凭据

外网请求保留 DNS/SSRF/固定 IP/逐跳重定向/超时/大小/取消防护。私网仅显式配置例外，其他边界不变。页面、RSS、附件和外部工具内容均是不可信数据。

浏览器全局复用唯一、懒启动、可见的 Chrome；受保护 profile/downloads 不进入工作区。模型不获得任意 JavaScript evaluate、cookie、localStorage 或密码。HTTP/WS 与浏览器工具共享同一服务；ticket、鉴权、帧背压与生命周期按生成契约执行。

模型 Key 只留受保护配置与内存，不写日志、客户端、auth 文件或 JSONL。模型/工具诊断在进入上下文和持久化前脱敏。trace 是旁路记录，过滤已知 Key、鉴权头与上游 URL 细节，失败不影响执行；不进入模型上下文。

## HTTP 与生命周期

`src/http/contracts/endpoints.ts` 是端点唯一清单，schema 同源生成 OpenAPI 与 Scalar。聊天执行流和全局通知流分开：聊天断开取消运行，通知断开不取消聊天。连接 ready 是恢复漏通知的同步边界。已提交的聊天、定时任务回复、通知和重置使对应历史失效；会话创建、改名和删除使目录失效；短信、新闻及通用习惯引擎状态变更通过 `domain_updated`（`{ instanceId, domain, scope }`）按领域和作用域定点失效。客户端读回权威数据，并按会话与运行代次屏蔽迟到结果。

初始化先校验/校准所有持久域，再启动调度。关闭同步关门、停止执行源和长连接、取消运行，等待已接纳 HTTP/副作用/通知收尾，最后关闭浏览器与追踪代理；清理幂等，单项失败不跳过其他资源。HTTP 不另建 writer、scheduler 或模型 runtime。

新能力先明确事实所有权、权限、审批、取消与失败语义；补契约与回归，执行[测试规范](testing.md)和[API 开发规范](api-development.md)。真实验收与文档页面缺失时明确标待验收。
