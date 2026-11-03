# 架构规范与新能力接入

本文是职责边界、状态所有权、生命周期、数据与权限细则的维护位置。修改业务、存储、权限或 pi 集成前必读；全局底线见 [AGENTS.md](../AGENTS.md)，测试与 API 交付分别见 [测试规范](testing.md)和 [API 开发规范](api-development.md)。当前进度与历史验收不在本文维护。

> 产品关系见 [功能模块、独立 Agent 与交互承接智能体的关系](discussions/feature-spaces-and-main.md)。Feature 独立存储与可更换的通知承接智能体已实现；默认互信的智能体请求与独立讨论按 REQ-016 分批实施，验收状态见需求池，不将后续讨论 UI 当作已有功能。

## 职责边界

单进程、单用户、单模型、多独立 agent 的模块化单体。保留函数式工厂、显式依赖注入、JSON 文件存储与 pi 内核，不为预防未来规模引入数据库、消息总线、持久队列或通用框架。

| 位置 | 负责 | 不负责 |
| --- | --- | --- |
| `src/index.ts`、`scripts/dev-mock.ts` | 配置加载、监听、信号退出；调用统一组合入口 | 业务规则、工具实现 |
| `src/config/load-config.ts` | 必需 JSON 配置、直接凭据与校验 | 环境变量回退、创建业务实例 |
| `src/bootstrap/create-service.ts`、`types.ts` | 唯一实例组装、启动校准、执行源启停、统一关闭 | DTO、agent loop |
| `src/features/` | conversation/messages/information/news/memory/identity/dream/jobs/goals/actions/monitors/skills/web/weather/workspace/activities/browser 的规则与最小 port | Hono、AG-UI、pi SDK、文件系统或具体 adapter |
| `src/adapters/pi/` | session factory、执行历史与消息事实投影、activity 记录与安全观察、诊断脱敏、资源隔离、prompt、工具装配与路径 guard | 第二份正文历史、手写 agent loop、反馈业务状态 |
| `src/adapters/ag-ui/` | SSE、事件投影、运行与取消适配 | 会话锁或业务域状态 |
| `src/adapters/storage/` | DataLayout、文件读写、各域 repository | 业务状态机、通用 CRUD 框架 |
| `src/adapters/web/`、`src/adapters/weather/`、`src/adapters/workspace/` | 安全网络传输、供应商适配、手动文件存储与提交队列 | 绕过 DNS/大小/超时/工作区路径边界 |
| `src/adapters/browser/` | 系统 Chrome 生命周期、CDP screencast、输入映射与可见结构投影 | HTTP/WS 协议、第二套浏览器实例或任意 evaluate 能力 |
| `src/adapters/auth/token-service.ts` | 登录、token 与签名密钥 | 业务规则 |
| `src/http/` | 鉴权、CORS、routes、contracts、presenter 与自动文档 | 创建业务实例、启动 scheduler |
| `web/src/` | 自有工作台、聊天 SSE、历史/任务/审批展示 | 自定义后端事实、复制手写 DTO |
| `src/shared/serialized-writer.ts` | 真正复用的串行写队列 | 杂项 utils、事件总线、DI 容器 |
| `tests/support/fake-model.ts` | OpenAI SSE 模拟 provider | 伪造业务工具副作用、替代真实模型验收 |

feature 只依赖业务类型与实际需要的最小 port；adapter 实现 port，bootstrap 显式连接。`tests/unit/dependencies.test.ts` 检查依赖方向；ID 生成允许 `node:crypto`。HTTP 只使用注入服务，不另建业务实例或启动调度。

## 作用域边界矩阵

**全局代码、全局数据与全量 prompt 是三件事**：代码能实现某个域不代表该域数据属于全局，数据可以全局存储也不代表每轮聊天都注入；普通聊天只携带基础身份/安全规则、当前智能体规则和本轮实际声明工具的对应说明。

| 作用域 | 归属内容 | 不归属内容 | 对模型上下文的影响 |
| --- | --- | --- | --- |
| 实例全局 | 模型与实例配置、SOUL/USER 与 identity、长期记忆、长期目标、技能资产与默认开关、共享系统 Chrome、`workspace/shared/` | 智能体规则、智能体技能覆盖、智能体私有文件、信息偏好、任务/监控归属、`local-main` 的父目录特权 | SOUL/USER/identity 每轮保留；memory/goal 只在对应工具实际可用时给使用说明，不自动灌入条目或标题；共享 Chrome 复用同一实例，不按智能体另建隔离浏览器 |
| 智能体 | `INSTRUCTIONS.md`、技能开关覆盖、私有工作区、信息设置/偏好 notes/原始信息与执行记录、jobs/monitors 归属、Dream 智能体配置与本地游标/待决建议 | 另一智能体的任何私有状态；全局技能资产本体 | 智能体规则每轮注入；技能开关从下一轮改变实际工具与说明，各智能体是独立执行与上下文主体，共用实例模型与全局资料 |
| 会话/运行 | PI JSONL 聊天正文与附件事实、消息反馈、run 内审批绑定与活动记录、子代理临时上下文 | 全局资料与记忆、其他智能体文件/历史、运行结束后的审批授权 | 只进入所属智能体会话；反馈不自动进入普通聊天上下文；新 run 不能继承旧 run 的审批 |
| 设备/客户端 | 连接地址、登录 token、通知/SSE 连接、浏览器调试页、客户端本地主题草稿/UI 状态与操作系统附件、通知等采集权限 | 业务事实所有权、模型 key、智能体规则或全局资料的第二套契约 | 断线/换设备后从服务端权威状态恢复；设备权限、本地草稿与连接状态不改变智能体或全局数据归属 |

全局管理 UI 可以聚合显示全局数据和多智能体状态，但聚合视图不是数据作用域；每个智能体具有自己的会话、指令、技能覆盖与私有文件；共享实例资料不意味着共享聊天上下文。reset 只清会话态并保留智能体态，delete 才按智能体级联清理；两者都不是删除全局身份/记忆或技能资产。

## 会话、状态与执行所有权

- `conversationHub` 每个 agent 缓存唯一协调器（含初始化 Promise），阻止重复创建两把锁；主会话 `local-main` 常驻。短生命周期锁串行协调初始化、HTTP 来源绑定、规则/技能保存和删除，不占用模型执行锁；删除先关门，旧引用关闭后不能向新同名会话投递。
- 历史读取和迟到 Stop 只查已有会话；不存在/已删 ID 返回空历史或 false，不 mkdir、不进入列表。显式新 run、规则/技能保存或来源绑定可建立会话；存在性以会话列表为准。
- 每个 conversation 独占 active run、运行锁和取消原因。客户端 run 与同 agent 的定时 trigger 共锁，其他用户 agent 独立；run 有客户端超时与断流取消，jobs trigger 保留既有无客户端超时语义，不擅自统一两者。
- pi 的 `createAgentSession` 负责执行循环、工具执行和持久化，SessionManager/JSONL 是唯一历史权威。聊天附件不落工作区、不建附件库：图片通过 SDK prompt images 进入同条 user message，UTF-8 正文以不可信数据包装进 prompt；custom turn 只存附件元数据，展示图片从该条 user message 的 image blocks 读取。展示读取完整 branch，模型 compaction/context edit 仍由 pi 管理，不维护第二套历史。
- PI 历史唯一权威指聊天正文、附件执行事实与工具结果不再复制；不禁止 Pi Muse 保存自己的业务事实。消息反馈保存在独立 repository，不能 append 到 PI branch、改变 expectedRevision 或自动进入普通聊天上下文；显式启用的信息后台可按智能体读取当前反馈例证。
- 模型与工具诊断在进入模型上下文和 pi 持久化前脱敏，不只是清洗 SSE 副本。默认文案为 `Tool execution failed` / `Model request failed`；仅 guard 声明的受控拒绝（`details.denied`）可透传。文件缺失使用受控 `File not found.`，技能诊断使用 `builtin/...` / `user/...` 逻辑路径。
- 工具副作用不因最终回复失败而回滚，失败不自动重试。停止后的半截 assistant 文本仍受 pi 的 `error/aborted` 历史过滤规则限制，不为恢复半截文本修改 pi。
- memory/identity 共用一个 repository 与完整读改写队列；其他持久域各有唯一 repository，同一文档不得在路由或工具中另开 writer。
- 用户会话缓存达到软上限后，只在后续获取时回收已闲置至少五分钟的非主会话，不回收运行中会话。软上限不是严格并发配额；会话列表活动时间取 JSONL 文件 mtime，不能取目录 mtime。
- `SOUL.md`、`USER.md`、identity 设置与会话 `INSTRUCTIONS.md` 每轮重读注入；`memory.json` 作为沉淀库按需由 `memory_search` 检索，且只在 memory 工具实际可用时提示条数与检索入口，不再全量拼入。长期目标不自动注入普通 prompt，启用 goal 工具时仅说明可按需查询全局目标。长期记忆可通过对话工具、HTTP 管理接口或受限的 Dream 后台整理写入（上限 500 条，满额拒绝新增而不静默截断）；会话指令与 Dream 提示词不能扩大工具、文件或审批权限。

## 智能体通信与独立讨论

- `features/agent-communication` 统一协调智能体发现、请求、原路回复与生命周期；模型 `agent` 工具和 HTTP 复用同一实例。内部智能体默认互信，不增加调用白名单、绑定授权或仅 main 可调用的限制；普通智能体与新闻/短信智能体均可发起和接收请求。
- 请求由目标智能体的独立讨论执行，使用目标的规则、技能、文件工具根和已有信息；后台自动处理关闭不阻止用户主动查询已有信息。两边的主聊天历史不自动带入，必要背景由调用方显式传递。已有鉴权、凭据保护、文件路径与模型写入审批仍生效。
- 每个事项对应一个 discussionId，目标 `sessions/<agentId>/discussions/<discussionId>/` 下的 pi JSONL 是正文、工具和请求/结果关联的唯一事实来源，不建第二份聊天库。后续轮显式沿用 discussionId；同一讨论运行中返回 BUSY，不排可靠队列，不自动续跑或重试。
- 请求回复直接返回原调用，不等待来源 conversation 的通知队列，不额外启动来源模型、不写入双方主聊天。通知绑定仅决定后台主动通知的落点，与请求可达性和回复地址无关。completed 只表示本次模型轮完成，回复可能是澄清问题；交给用户回答后再发下一轮，不让模型猜用户选择。
- 跨智能体执行产生的文件审批归原调用智能体/运行，预览中的 workspaceAgentId/ownerAgentId 保持实际目标智能体，用户可在来源会话查看并决定；下游继续请求沿用同一审批归属。普通文件仍只能写执行智能体工具根，不能因回传审批而写入来源工作区。
- Stop/调用方断开、超时和服务关闭取消请求及其下游工具。reset/delete 先暂停涉及该智能体的来源和目标执行；目标 reset 清理自己全部讨论，delete 随智能体删除；来源 reset 不删除其他目标已有讨论，但旧请求不会投递到来源新会话。已有副作用不因取消回滚，不重放未明写入。
- 默认群聊由 `features/group-chat` 协调显式投递；无目标只交 main，显式 @ 只交一个目标，不猜路由、不广播。每个成员独立延续自己的群讨论，与私聊独立。`DATA_DIR/group.json` 仅保存请求/来源/目标/讨论/状态索引，正文与工具事实仍只从目标 pi JSONL 投影；嵌套 agent 请求记录真实来源。群时间线永不作为模型输入。
- 群发送复用通信 runner 与原审批所有权，逐轮投影已有执行事件；Stop 绑定根请求，断流取消完整调用链，重启仅将未完成索引标为取消，不续跑；结果未明先 GET 核对。reset/delete 清理目标讨论及对应索引，不删除其他智能体讨论。当前一个固定群、文本输入，不含群附件/消息反馈，功能通知通过实际承接会话的服务端 marker 只读投影到群展示，不迁移正文、不合并普通私聊、不改变模型上下文；当前快照不再存在的通知不返回，改绑不移动旧通知。群及会话列表复用 ready/conversation_updated 失效回读，发送中延后到收口，不增加 SSE 或轮询；来源卡片「继续处理」和独立讨论页仍待后续。评论反馈不自动触发智能体任务。

## 消息业务层与反馈

- `features/messages` 是对外消息业务主路径，定义 PI 无关的消息事实、反馈状态与最小 repository port；conversation 的 snapshot 和 completed 幂等重放必须经它投影，不保留无消息层的备用读取路径。
- PI adapter 只提供执行事实：稳定消息 ID、角色、对应 PI entry 时间、run/job/notification 可验证来源、context_edit 后仍存在与当前 run 可用性。旧历史缺少来源事实时返回 `source:null`，不按正文、runId 前缀或 Markdown 猜测。
- 反馈归属为 `agentId + sessionId + messageId`。喜欢/不喜欢互斥且可置空撤销；同一消息允许多条服务端 ID 评论，文本 trim 后非空且最多 4000 字符。工具结果不可反馈，当前生成中的消息不可反馈；同智能体旧落盘消息在其他流式运行期间仍可反馈。
- `messages/<agentId>/<sessionId>.json` 保存原始操作事件：reaction 变更/撤销、评论新增、编辑（旧新文本）、删除（删除前文本）及服务端时间。当前反馈和事件均由事件流投影，不能只存最终值，也不能把反馈 append 进 PI branch。
- reset 生成新 sessionId 并按智能体清理反馈文件；delete 级联清理。旧 sessionId 返回 409，不迁移到新会话，也不得复活已删除智能体。repository 读写、清理与 reset/delete 共用串行队列；文件缺失视为空反馈，损坏文件启动或读取时报错。
- 反馈记录操作本身不触发模型、Dream、自动记忆或偏好学习，也不从 Markdown 拆推荐条目；信息后台启用后可在独立决策轮读取当前智能体、当前会话的有限最新例证。这不是训练，也不把点赞泛化为全局偏好；显式智能体规则与偏好 notes 优先。

## 通用信息后台

- `features/information` 是普通智能体与内部功能复用的处理内核：设置、偏好 notes、原始条目与执行记录保存在 `information/<agentId>.json`，不是 PI JSONL。普通 HTTP 入口鉴权且目标必须已存在，不接受内部功能智能体；GET/迟到输入/后台结果不创建或复活智能体。设置默认 `false/15s`，0 表示到期即时聚合；reset 保留该文件但中断在途轮，delete 级联删除。
- 接入按整批校验，最多 50 条；`source+externalId` 是智能体内幂等键。完全相同原始内容、标题与显式来源时间幂等回读稳定 ID；同 key 不同内容返回 409 且不覆盖原文。省略 `receivedAt` 的重复请求以首次落库时间为准；正文与标题仅拒绝全空白，不 trim 或改写。
- 后台单进程全局只有一个执行槽；手动 run 与 scheduler 在首个 await 前同步争用。每轮最多 20 条、60000 字符，并从最早 pending 条目聚合。pending 落盘；重启将遗留 `running` 标为 failed，也不重放“模型已完成但发布未确认”的轮次。
- 执行轮使用 `createAgentSession` 的独立内存 SessionManager，只装配 `submit_information_result` 工具；不提供 bash/write/edit/read、网络、memory、instructions 写、skills.save 或委派能力。智能体规则与已启用技能的 `SKILL.md` 纯文本作为指引，不能扩权；原始信息、反馈和来源时间都是不可信数据。
- 结构化提交由 PI 无关的共享校验器强制：每个本批 item 恰好一次 silent/notify 决策，notify item 恰好被一条通知覆盖，silent 不得发布，reason/text 与引用有界。SDK 整轮成功且最终恰好一个有效工具提交才持久化决策；同一 SDK 轮内无效提交可收到工具错误并自行纠正，不触发应用重跑；空自然语言确认不要求，漏调/最终无有效提交/两次有效提交/请求失败均 failed 且不自动重试。
- 发布经唯一 `conversation.notify` 入口使用稳定 notificationId，repository 记录 run → 原始 items → notificationId/sessionId/messageId。通知排队未落盘前可被 disable/reset/delete/shutdown 撤销；已落盘消息不回滚。发布前检查取消、设置与目标 session，模型成功而投递失败时保留 model succeeded 并单独记录 publication failed。
- 仅当前智能体 `information.settings.enabled=true` 的普通主聊天装配信息后台说明、只读 `information` 工具和普通信息通知的来源投影；每轮重新读取设置，读取失败中止本轮，关闭智能体与子代理不装配该工具。工具固定闭包到当前智能体，仅能查询本智能体信息、run、偏好与发布关联；短信接入、供应商适配与移动端管理界面不在该域内。独立功能来源投影不依赖普通信息开关。
- 启用智能体的系统提示词说明通知边界；PI 公开 `context` hook 仅在模型请求前把带服务端 marker 且符合稳定 `info-notification-inforun_UUID-index` 格式的通知包装为来源、notificationId、runId 与不可信原文。该投影不修改 PI JSONL/UI 原文/revision，也不运行时查库；通用服务端通知、普通 assistant/user 或用户伪造文本不得获得信息后台来源。

## 独立功能与交互承接

- `features/agent-extensions` 管理 news/sms 的附加业务和通知承接关系；稳定 ID 为 `news-internal`、`sms-internal`，标识符中的 internal 不代表核心能力限制。所有智能体共用 `/api/agents` 目录、聊天、文件、规则、技能、Dream 和任务能力；目录的 `extensions` 只声明附加业务，不区分完整与受限智能体。目录不建立第二套身份存储，也不因读取而初始化私聊。短信专用 facade 固定内部 owner，不接受客户端传入内部 agentId；后台设置/采集仍只能走该 facade，主动私聊即使后台关闭也可查询该成员已有信息，不隐式启用监听。
- `features.json` 仅保存一个功能到一个稳定智能体的绑定，以及已落盘消息的来源关联，不复制消息、原始条目或反馈。首次缺失默认 `local-main`；损坏数据报错。绑定更换接受任意已存在智能体，包括新闻与短信，最后保存生效，不移动任何功能数据或聊天历史；绑定目标删除前必须显式改绑，不静默回退 main。
- 通知模式在接纳处理轮时解析一次承接智能体并固定目标 session；改绑不移动在途消息，reset/停止/删除使旧投递失败，保留模型成功事实，不重跑、不自动投递新会话。新闻带入讨论由服务端读取原文，调用同一 `conversation.notify`，落盘成功后返回实际目标凭据；不自动提问或启动模型。
- `featureSource` 仅来自服务端通知 marker，投影到历史 metadata 与模型上下文；不从正文或客户端回传推断来源。原始新闻与短信始终是不可信数据。`feature` 工具只允许主聊天沿当前会话中真实消息的来源读取条目、保存明确反应/评论；不提供任意内部 Agent、文件、配置、规则或全局记忆写权限，子代理不装配。
- 明确的条目反馈保存在对应功能的 information 文档；气泡反馈仍在消息 repository。功能下一轮按真实投递关联读取有界最新气泡例证及逐条反馈，不把一次反应泛化为永久屏蔽。reset 删除被清理聊天的反馈与关联，保留功能条目与偏好，不恢复旧消息；改绑后旧消息仍可沿原来源反馈。
- 客户端 `SmsProvider` 按连接挂载一次，不受页面与当前智能体切换影响。自动短信只在 Android 本地原生模块可用、权限已授予、功能启用且进程存活时监听；不承诺进程终止后的采集，不提供 OS 推送。历史普通智能体 information 数据保持原所有权，不隐式迁移或接管。

## 新闻阅读

- 新闻智能体 `news-internal` 拥有完整的聊天、历史、指令、技能、文件、Dream 和会话重置能力；阅读视图、RSS 采集与推荐处理是它的业务扩展。新闻专用 HTTP facade 固定数据 owner，不暴露 agentId，也不允许通用 information 设置改掉推荐模式。新闻和短信内置智能体不可删除，这是业务数据生命周期约束，不是核心能力等级。
- `news.json` 只保存 RSS 源配置与采集健康状态；文章正文、结构化元数据、模型决策、推荐理由和逐篇反馈继续保存在 `information/<agentId>.json`，不建立第二套文章库。RSS 采集是薄 edge：复用 `safePublicGet` 的 DNS/SSRF、固定 IP、逐跳重定向、总超时、大小与 AbortSignal 边界；XML 解析位于 `src/adapters/news/`，feature 只接收解析后的 feed。`fast-xml-parser` 严格解析 RSS2，并同时限制输入大小、条目数和嵌套深度；拒绝 DTD/实体声明、损坏 XML 与不稳定条目。条目缺 title 或正文时整个源受控失败，不静默当作空源。所有 HTML 在解码后清理为纯文本，绝不执行。
- 普通智能体 information 仍使用通知模式；新闻智能体使用 recommendation 模式。推荐模式只持久化每个 item 的 `notify`（选中）/`silent` 决策与 reason，不要求或创建 conversation publication，也不刷新任何聊天历史。普通 information HTTP 契约不暴露内部 mode 或 learnedNotes。新建新闻智能体的默认指令要求推荐理由与 learnedNotes 使用简洁简体中文，但 RSS 标题和正文保留原文、不翻译；已有非空 INSTRUCTIONS 不被覆盖。
- 文章按发布时间（无效时使用接纳时间）与稳定 ID 倒序分页；推荐视图只投影已完成且模型成功的 notify 决策。`savedOnly` 只过滤不改变排序。模型失败不产生假推荐，全部时间线仍可读。
- 喜欢/不喜欢、收藏、评论按 articleId 智能体局部保存；评论 trim 后非空且最多 4000 字符。反馈不绑定聊天消息/session，主会话 reset 不清除；最近反馈按最后交互顺序进入下一轮有限分析输入，收藏为弱信号。只有结构化成功结果才更新 learnedNotes，且不覆盖显式 notes、INSTRUCTIONS 或全局 USER。
- RSS 源默认每 30 分钟采集；后台定时轮只抓取，不重排 failed 条目。手动 refresh 同步完成抓取但不等待模型，并可在没有运行中新闻批次时重置已知 failed 条目；同一时刻只允许一个 refresh。源故障记录受控错误并继续处理其他源；删除源只停止采集，文章与反馈保留。模型失败保持 failed 且不自动重试，运行中的批次不重排。

## 后台调度与通知

当前后台行为包含 jobs / monitors / dream；subagent 是父模型调用的工具，不是后台任务域。

| 域 | 执行方式 | 结果与失败 |
| --- | --- | --- |
| jobs | 定时到期后在所属会话执行真实 pi 轮，与该会话聊天争锁 | 按 nanobot 重算 daily；过期一次性任务启动不补跑；保存失败只补存同一次已得结果和完成时间，不重跑模型/工具 |
| monitors | 固定扫表，到期抓取复用 web 安全边界；不启动模型轮 | change 为指纹变化，首检建基线不通知；contains 从未命中进入命中才通知；抓取失败只记 error |
| dream | 固定 2 小时周期扫描已开启会话（主会话默认开启，其他默认关闭），按智能体游标+约 4k token 重叠窗口读取新消息，在独立内存 SessionManager 中运行仅含 `propose_notes` 的受限整理轮 | 会话忙或无新消息时跳过；默认与固定规则要求 USER/SOUL/MEMORY 只收跨智能体稳定内容，智能体用途导致的筛选、敏感度与格式偏好进当前 INSTRUCTIONS，信息偏好 notes 仍由信息域维护；跨智能体范围不明的新建议进 `pending`，不确定的既有 memory 编辑/删除应放弃而不是转成新增；非主会话仅 USER/SOUL 建议强制进 `pending`，不意味着所有 memory 建议都降级；写前校验文件版本与 `## 智能体用途`，无用途会话指令进 `pending` 待用户确认；确切 memory id 的编辑/删除仍保持原语义；仅整轮无跳过/无失败时推进游标，重启遗留 `running` 标为 `failed` |

- monitor 默认每 60 秒扫描到期的 active 项，检查间隔为分钟级；支持 pause/resume/stop。入口为对话 `monitor` 工具与 `POST /api/monitors`，调用结构以生成契约为准。
- jobs/monitors 仅省略 `originAgentId` 时使用主会话。显式新来源在接纳前建立，删除中的来源绑定返回 409；删除来源后的迟到通知不改投主会话、不复活会话或投向新同名会话。解析目的地后重查绑定，不能执行旧扫描快照。
- 完成通知是确定性的服务端事实，不伪造用户请求或再调用模型总结，避免通知再次执行有副作用的工具。通知经 `conversation.notify` 写入 pi 历史；忙时排队，轮次释放前落盘，稳定 ID 去重。
- 新会话只有 custom entry 时 pi 不创建文件，因此通知使用公开 `appendMessage` 接口，明确标识 `personal-bot/server-notification`、零模型消耗，稳定 ID 同条写入。UI 独立展示，后续模型上下文可见，不另建历史数据库。
- monitor 先保存 pendingNotification，再投递和确认；扫描不等待投递，按 monitor/notification ID 跟踪进程内在途通知。已有 pending 时不新抓取覆盖，单项错误不阻断其他监控；只有投递成功才更新 lastNotifiedAt，下次扫描可补通知而不重新抓取或执行模型。
- jobs 结果以 jobs.json 为准；通知失败不重试任务，仍可从详情查看。进程崩溃不承诺任务通知必达，也不恢复未完成模型轮。定时触发轮不接入当前聊天实时 SSE，刷新或下轮同步后可见；旧 revision 可能触发一次 409，同步规则见生成契约。

## 子代理（subagent）

- 实现为 `src/adapters/pi/subagent/extension.ts` 与 `session-factory.ts` 的 SDK child 装配，基于官方 1.3.0 subagent 示例；本地统一顶层入参为必填 `mode`（`single` / `parallel` / `chain`）与 `tasks` 数组（1-8 项 `{agent, task}`），移除旧顶层 `agent`/`task`/`chain` 混传入口，并声明 `constrainedSampling` strict prefer。`single` 要求恰好 1 项；数量不符或角色未知时，在排队前以固定安全文案拒绝（`denied: true`，不回显非法输入）。同进程内独立 SDK session 上下文隔离，不写自造 loop。最多 8 项、同时 4 个，链式失败即停，不自动重试。
- 子模型继承父 session 的 model/key；角色和工具只能收窄父会话已启用技能与工具上限，不开放 bash/subagent/schedule/monitor/instructions，不读取个人 `~/.pi`，不接受 `cwd` / `agentScope` 等越界参数。
- 每个调用独占 `workspace/agents/subagent-<uuid>/`，不复制父 workspace、历史或 `INSTRUCTIONS.md`；仅 `shared/...` 显式互通。写/编辑仍逐次人工审批，归属父 agent/run；父 Stop、超时或聊天断流取消子会话并等待清理。
- 子会话不持久化，结果作为父工具结果回写；`subagent-*` 内部工作区不作为用户会话展示。role 来自内置 `assets/subagents/<role>.md`，`DATA_DIR/subagents/*.md` 可覆盖；角色不允许另配 model，来源与本地差异见 [适配说明](../src/adapters/pi/subagent/README.md)。
- **旧 worker 的现行处理边界**：旧 `tasks.json`、`task-*` 目录不读、不迁移、不删除、不执行，不保留旧 reader；遗留 `task-*` 从用户列表和父文件根解析中过滤。`delegate_task`、`POST /api/agent/tasks`、`target: task` 分发已下线；原 `task` 技能名只装载 subagent，保留是为了不破坏会话技能覆盖。工作区快照 `/api/identity` 已解耦为仅保留 `identity`，定时任务收拢至独立 `/api/jobs`，删除智能体的 removed 只统计 jobs/monitors。更早实现仅查 archive，不恢复旧队列。

## 工作活动（Activity）

- **定义与自主决策**：Activity 是主 Agent 被交办具体工作目标并实际推进执行的过程记录。由主 Agent 根据对话上下文自主决定是否调用 `activity` 工具登记（`start`），不使用关键词白名单、耗时阈值或分类模型；普通问答、解释、澄清、方案讨论与简单查询不作为活动登记。
- **生命周期状态机**：明确区分 `running`、`waiting_approval`、`waiting_user`、`awaiting_continuation`、`completed`、`failed`、`stopped`、`interrupted`。同一执行轮次至多绑定一项活动，重复 `start` 幂等返回当前活动；下一轮不自动续跑或绑定，由 Agent 显式调用 `resume`。
- **完成保护**：调用 `complete` 仅表示完成声明，须在当前轮次所有工具/子代理/审批步骤均已结束时方可调用；实际状态维持 pending，仅当本轮模型顺利收尾且最终回复文本成功交付客户端后，才在服务端投影为 `completed`；若中途又执行其它工具、被用户 Stop、失败或中断，声明失效并如实反映真实终态。
- **权威存储与级联生命周期**：Activity 概览与步骤均以 custom entries (`pi-muse.activity`) 保存于该 agent 唯一的 SessionManager / JSONL 历史树中，不维护第二套历史或单独的 activities.json。来源会话被删除时，其活动记录随 JSONL 物理文件一并清理；重新建立同名会话不会复活已删除活动。
- **真实逐步明细与安全观察**：明细步骤由 `createActivityObserver` 从真实的 SDK 事件流与审批回调捕获（包含 execution、model、tool、subagent、approval、file_commit），不依赖模型在事后回忆或编造。子代理步骤以 `main:tool:<parentCallId>` 为 parentId 形成嵌套；所有步骤严格遵守脱敏与安全展示规则，不暴露原始工具参数、全文载荷、模型思维或内部诊断。
- **查询接口**：对外暴露只读的 `GET /api/activities`（支持 `limit` 1–100、不透明 base64url 游标、`agentId` 与 `status` 过滤；按 `createdAt` 倒序及唯一 ID 全序稳定排序）与 `GET /api/activities/:id`（概览与逐步明细）；不提供前端直接写或强制完成活动的 HTTP 接口。分页不冻结快照。

## 文件工具与审批

- read/grep/find/ls 默认只可达 `DATA_DIR/workspace/agents/<agentId>/`，主会话使用 `agents/local-main/`，无父目录特权。`workspace/`、`agents/` 仅是容器，不得回退为会话根；`shared/...` 仅映射到 `workspace/shared/`。HTTP 手动文件管理使用显式 `scope=agent|shared` 选择根，不再解释 `shared/` 前缀；scope=agent 必须指向已有智能体，GET 与写操作都不隐式创建智能体。
- 拒绝绝对路径、`..`、根/中间目录/目标符号链接。只读 operations 核查 SDK 最终解析路径，递归 grep/find 不跟随链接，ls 跳过链接。仅 read 可额外读取本轮启用技能的精确 `SKILL.md` 与 `references/`、`assets/` 下受支持文本资源；例外按技能根到目标的全链路逐次复核，不开放 ls/grep/find、相邻文件、配置或代码。
- `bash` 永不暴露。`write`/`edit` 默认开启，可由 `tools.writable.enabled` 关闭；仅注册受控工具，不开放 pi 默认的无限制写工具。主会话另有 `skills` 技能维护工具：`action=list|read|save`，`name` 为小写字母/数字/连字符且至多 64 位，`file` 默认 `SKILL.md`，`save` 必须提供完整 UTF-8 内容；该工具由默认启用的 `skill-creator` 技能映射，子代理不装配。
- `skills.list` 返回当前智能体生效状态与 builtin/user 来源，不返回物理路径；`skills.read` 可读已安装或禁用技能以供编辑。`skills.save` 只写 `DATA_DIR/skills/<name>`；同名内置技能写成实例覆盖，绝不修改内置文件。资源文件必须等合法实例 `SKILL.md` 先存在，避免产生 loader 看不到的孤儿资源。
- 技能文件仅允许 `SKILL.md` 与 `references/`、`assets/` 下 `.md/.txt/.json/.csv/.yaml/.yml` 普通文本，单文件 100KB；拒绝路径穿越、绝对路径、空格/非法文件名、符号链接、目录操作、`config.json`、脚本/代码与二进制。`SKILL.md` 先用 pi `parseFrontmatter` 精确要求 frontmatter `name === 目录名`，再复用 `loadSkillsFromDir` 全量校验。禁止在资源目录保存嵌套 `SKILL.md`。
- 技能保存复用 file_write/file_edit 审批、版本绑定、Stop/过期/拒绝语义与共享提交队列。审批 preview 使用 `scope=skill`、`ownerAgentId=null`、`workspaceAgentId=null`，逻辑 path 为 `<name>/<file>`；批准提交后回读确认。新建技能仅系统创建 `{ "defaultEnabled": false }`，不隐式打开全局或当前智能体；启用后的变化从下一轮模型装配生效，结果未明不得自动重发。
- `tools.writable.enabled=false` 时 `skills.list/read` 仍可用，`skills.save` 受控拒绝；该开关仍会移除普通 `write/edit`，不扩大普通工作区权限。技能 authoring 不提供删除、市场、版本平台或 extension 编辑；已安装 extension 属可信服务端代码，与可编辑文本资源隔离。
- 审批域记录人的决定和工具回报的执行事实，不直接执行副作用。每次操作登记完整路径、内容/编辑前后文本、文件基准版本及 agentId/runId/expiresAt，可关联 activityId/toolCallId；Web 原样转义展示完整预览，不能只展示截断摘要让人批准。
- 截止时间登记时固定，决定时原子检查过期；Stop/abort 撤销 pending，启动前撤销旧进程遗留 pending。批准旧卡片不能复活已取消的执行。
- 提交前再次核对路径、版本、审批期限与取消状态。不同工具实例共用逐物理路径队列；文件变化必须重新申请审批。拒绝、过期或运行取消不提交该次修改，不覆盖他人新内容。手动 HTTP 新建/更新/删除与模型工具提交注入同一个队列；HTTP 更新同样先写临时文件再替换，不截断旧文件。客户端必须在调用前完整展示 before/after 并取得用户确认，但这不是模型审批，也不能改变模型工具的版本绑定审批。
- 写入/编辑先写同目录临时文件再提交，限制正文大小；保护针对单进程工具并发，不承诺抵御外部恶意进程在最终检查与 rename 间的路径竞争，不增加跨进程锁或事务框架。
- approved 仅表示人的批准，不代表磁盘提交成功。工具先原子登记执行开始，再报告实际提交结果；无执行回报时不推断成功，重启将遗留 running 执行标记 unknown，不重跑文件操作。会话规则、技能开关和展示策略不能绕过路径边界或审批。
- 终态历史与登记时的完整预览长期保留，不按时间或条数裁剪；历史分页只返回摘要，完整预览按需读取详情。相同决定幂等返回，不延长授权也不重新执行；相反决定、过期或取消发生冲突。读取 pending 不返回过期项，也不为查询改写决定状态。
- 审批预览主要通过 SSE 直接推送；人工决定及每次执行回执递增持久 revision，防止客户端按版本去重时丢失执行结果。resolvedAt 表示审批终态时间；decidedAt 只表示人工批准/拒绝，过期或取消不得伪造人的决定。历史按 resolvedAt 倒序分页，查询过滤与游标绑定。
- 路径 guard 不是操作系统沙箱；已安装的可信技能 extension 是服务端代码，不承诺用普通文件工具边界限制它。

## 外部 Web 与凭据

- Web 工具默认仅允许公网 HTTP(S)：DNS 校验、私网拒绝、固定解析防 rebinding、重定向逐跳校验、响应大小及超时限制。`tools.web.allowPrivateTargets: true` 仅显式放宽私网目标，不改变其余边界。搜索摘要和页面内容必须标记不可信数据。
- Web service 返回结构化成功/失败联合结果，监控等业务消费者直接读取；pi 工具层才负责 JSON 序列化与错误标记，不从工具文本反向解析业务状态。
- 取消信号必须沿工具、service、transport 传到在途网络请求，停止不伪装成普通成功或触发搜索兜底；不能只取消客户端显示而等待工具继续执行。
- 模型 key 只在受保护实例配置与服务端内存，不写 pi auth.json、日志、客户端或 JSONL；provider/runtime key 在 bootstrap 注册一次。独立资源目录不加载个人 CLI 全局配置、skills、extensions 或 MCP。
- 单进程单 DATA_DIR；保留 accessKey 鉴权中间件。默认 `0.0.0.0` 便于局域网访问，缺 accessKey 会警告；生产部署应显式配置访问密钥。配置和启动细节见 [配置说明](manual/configuration.md)。
- 真实浏览器是独立 `browser` 域，不复用 `web_fetch`。默认同样拒绝私网目标；`tools.browser.allowPrivateTargets` 仅用于本机联调。页面标题、文本和元素名是不可信数据；不向模型暴露任意 JavaScript evaluate，不返回 cookie/localStorage/密码值。

## 真实浏览器

- `BrowserService` 是全局唯一入口，HTTP REST、`/browser` 调试页、WS 输入与 Agent 工具共享同一个懒启动、始终带 GUI 的系统 Chrome 和持久 profile；不做多实例、控制权租约或崩溃恢复框架。当前原生标签由 Browser root CDP 的 `tabActive` 元数据判定，不依赖会被 focus emulation 影响的 DOM `visibilityState`；CDP 帧流转发该标签视口。Docker 场景另用 Xvfb/x11vnc/noVNC 暴露完整真实窗口，两者不替代彼此，也不用无头渲染替代 GUI。
- 应用是浏览器进程信号的唯一所有者：Playwright launch 显式关闭 SIGINT/SIGTERM/SIGHUP 自动处理，避免应用 `service.close` 与 Playwright handler 并发关闭同一 Browser 时触发二次 `gracefullyClose` 强制 kill。
- 文件上传只由真实页面 `filechooser` 事件建立待处理项，每页最多一个当前 chooser；新 chooser 替换旧项，主导航或页面关闭使其失效。用户明确提交后，Playwright 使用请求中的内存字节调用 `setFiles`，不读取服务端路径或 workspace，也不注册为模型工具；取消只删除待处理项，不替页面清空已有选择。
- 下载只来自 Playwright `download` 事件，持久化在 `browser/downloads/<uuid>/content` 与 `meta.json`。目录和文件受保护，不进入 workspace；完成记录重启后可读，中断记录标 failed，超限或失败清理自身临时内容，不自动重下。HTTP 只投影安全元数据与内存 Base64，不暴露 Playwright 或文件系统原始错误。
- 全局只维护一份标签列表；仅当前激活标签在有 WS 订阅者时启动 CDP screencast，切换标签先停止旧流再启动新流，无订阅者时停止推帧。有 screencast 时用单个不重叠的 1 秒周期探测同步 noVNC 中手工切换的原生标签；停止 screencast、关闭或 context 失效时清理探测。标签识别要求 Chrome 150+ 的原生 tab metadata，缺失时返回受控 `BrowserError`，不按 URL、标签顺序或旧版 DOM 行为猜测。慢客户端按未 ack 帧跳帧，缓冲超限时断开。
- WS 先用现有 Bearer token 换取一次性短时 ticket，长期 token 不进入 URL；帧格式、输入消息与 ack 语义以 `src/http/contracts/browser.ts` 生成的 OpenAPI extension 为准。
- Docker 场景的 noVNC 桌面不单独发布端口：websockify 只绑定容器内 127.0.0.1（`tools.browser.desktopPort`），服务端以同源 `/browser/desktop/` 前缀代理。`POST /api/browser/desktop-ticket`（Bearer）换一次性 60 秒 ticket，`GET /browser/desktop/launch` 消费 ticket 签发 1 小时 HttpOnly 会话 cookie；静态资源与 `/browser/desktop/websockify` WS 都由该 cookie 把关，cookie 绝不授权 `/api`。网关由 bootstrap 装配单例并注入 routes 与 Node server upgrade；`/ws/browser` 与桌面 websockify 共用统一 upgrade 分发，互不劫持。HTTPS 终止反代不受支持（Secure 标记与 WS Origin 按直连协议判定）。
- snapshot 是基于浏览器无障碍树的可见结构投影，包含角色、ref、shadow DOM 与 iframe 内容及正文投影；外部内容一律标记不可信，不提供任意 JavaScript evaluate。
- 浏览器核心只依赖 `features/browser`、`adapters/browser` 与基础 shared 工具；REST/WS 是薄协议适配，pi 工具是薄入口适配。禁止 browser 引用 `web_fetch`、conversation 或应用组装层，保证后续可以整体抽成独立浏览器服务。

## 生命周期

1. 组装 repository/services，读取并校验持久域（含消息反馈与信息事件文件）；重算 jobs、撤销旧 pending 审批，校准中断的信息 run，不恢复崩溃模型轮或旧 worker。所有实际执行源最后才启动。
2. HTTP/协议复用已注入服务，不自行启动 scheduler。service.close 同步关门，新 HTTP 请求返回 503，hub/scheduler/subagent 不再创建或派发新工作。
3. 先停调度、取消会话并结束工作区通知长连接，等待已发出的执行、通知、状态写入和已接纳 HTTP 请求收尾。关闭必须幂等，某个清理失败也不跳过其他实例。
4. 进程入口停止接收连接并等待 close；mock 入口额外关闭 fake provider，浏览器域结束 WS 订阅并优雅关闭 Chrome。初始化失败也必须清理本次已分配资源，不能遗留定时器、socket 或进程。

## 数据布局与校验

路径统一由 `src/adapters/storage/data-layout.ts` 声明，不在新能力里散写路径。下表基于 DATA_DIR；内置 assets 随服务代码/构建发布，不是新增实例状态。

| 路径 | 内容 |
| --- | --- |
| `sessions/<agentId>/*.jsonl` | 智能体主聊天的 pi 历史唯一权威来源 |
| `sessions/<agentId>/discussions/<discussionId>/*.jsonl` | 目标智能体独立讨论的 pi 正文、工具事实及请求关联；不进入主聊天列表，目标 reset/delete 清理 |
| `messages/<agentId>/<sessionId>.json` | Pi Muse 消息反馈原始事件；正文仍在上方 PI JSONL |
| `information/<agentId>.json` | 智能体局部信息设置、偏好 notes、原始条目、模型决策与发布溯源；reset 保留，delete 级联删除 |
| `news.json` | RSS 源配置、最近抓取时间和受控错误；删除源不改写已接纳文章与反馈 |
| `sessions/<agentId>/INSTRUCTIONS.md` | 本会话专属规则（含 `## 智能体用途`），下一轮注入 |
| `sessions/<agentId>/DREAM.md` | 本会话补充 Dream 提示词，按需存在 |
| `sessions/<agentId>/dream.json` | 本会话 Dream 开关、游标、最近结果与待确认项，按需存在 |
| `sessions/<agentId>/skills.json` | 本会话技能开关覆盖，技能资产全局一份 |
| `profile/SOUL.md` / `profile/USER.md` / `profile/DREAM.md` | 全局自由文本身份与 Dream 提示词（`DREAM.md` 缺失时回退内置默认） |
| `profile/memory.json` | 长期记忆（按需检索）与 identity 设置 |
| `jobs.json` / `goals.json` / `actions.json` / `monitors.json` | 对应域持久状态 |
| `workspace/agents/<agentId>/` | 会话私有文件工具根；主会话也在此布局内 |
| `workspace/shared/` | 全局共享区，用 `shared/...` 显式访问 |
| `subagents/*.md` | 实例级 role 覆盖，优先于内置 `assets/subagents/<role>.md` |
| `skills/<name>/SKILL.md` | 实例级技能资产 |
| `config.json` / `auth.key` / `agent/` | 必需配置、token 签名密钥与 pi 运行资源 |
| `browser/profile/` | 系统 Chrome 持久 profile；与配置同级按敏感登录态保护，不给普通文件工具访问 |
| `browser/downloads/<uuid>/content`、`meta.json` | Playwright 下载内容与状态；独立于 workspace，目录 `0700`、文件 `0600`，普通文件工具不可访问 |

- pi `continueRecent` 与执行使用同一会话私有 cwd；重启仅恢复相同 cwd 的权威历史，不回退旧路径。sessions 初始化只 mkdir，不探测、搬移或删除旧 workspace 根文件与旧历史；已有数据需停服后单独备份处理。
- `memory.json` 为 `{ memories: [...], identity: {...} }`，已有文档必须包含完整 identity；jobs/goals/actions/monitors 为裸数组。持久业务文档目前不写 `schemaVersion`，拒绝带版本的对象，等待显式版本 reader；不要与启动配置的 schemaVersion 混淆。
- 仅文件缺失可返回初始化默认值（`SOUL.md`/`USER.md`/`DREAM.md`/`INSTRUCTIONS.md` 同样仅 `ENOENT` 视为空串，其他 I/O 错误抛错）；JSON 损坏、非法根结构、已知字段类型错误、未知版本与其他 I/O 错误必须抛错。每个条目都应符合当前 reader，任一坏条目整体拒绝，禁止过滤后静默丢失或填补已有文档字段。
- 写入先在内存序列化，以 `wx`、`0600` 创建同目录临时文件，再 `rename`；文本档案与会话指令共用带预期版本比对的原子写入口，防止后台整理覆盖并发编辑。不做 fsync、自动重试、跨进程锁或 durable execution。
- 损坏文件需停止服务、保留原件并从有效备份恢复，不直接删文件消除报错。未来格式/路径变更单独设计离线迁移与回退，不运行中双写，不保留隐式旧 reader。
- `runtime.dataDir` 省略或为相对路径时按配置文件目录解析，不按进程 cwd；嵌套目录陷阱与完整实例树见 [配置说明](manual/configuration.md#instance-directory-structure)。

## HTTP 与前端适配边界

本节只说明层间职责，字段和客户端关键接入步骤必须来自 `src/http/contracts/` 与生成的 `/docs` / `/openapi.json`，不在 Markdown 维护第二份规范；修改前读 [API 开发规范](api-development.md)。

- Hono 直接处理聊天增量请求并输出 AG-UI SSE，不引入 CopilotKit runtime、PiAgent 或旧宿主 runner；HTTP/presenter 不拥有业务状态。
- DTO、消息、事件联合类型从 schema 推导，自有 Web 对入站 SSE 同源校验，畸形事件或缺终态断流明确失败，不伪造成功。
- Web history/SSE/结束刷新绑定 agent 与运行代次，切换/卸载取消原流。客户端同步 revision、恢复冲突草稿并等待 Stop 收尾，具体协议由生成契约约束，不自行用旧快照覆盖服务端事实。
- 审批单独读取 pending 完整预览、历史摘要与详情，不塞入工作台快照；token 是前端唯一认证事实，401 与跨标签退出及时同步登录状态。
- `src/bootstrap/service-version.ts` 在源码启动时固定 package/git/白名单源码 SHA-256 快照；构建产物读取 `dist/service-version.json`，不在请求时执行 git 或读取源码。health、OpenAPI 和 Scalar 共用版本身份，dirty=true 时比较 sourceHash，不只比较 commit。
- `/api/events` 是单向工作区推送：运行/审批/活动携带展示投影，通知落盘只发送会话身份失效信号；断开此流不取消聊天。聊天流与工作区通知的事件表和取消语义不得混用，具体协议以各自契约为准。

## 新能力接入

1. 无状态只读工具直接放 `src/adapters/pi/tools/`；有独立业务规则或持久化才新增 `src/features/<name>/`，文件读写放 storage adapter。
2. 工具在 `src/adapters/pi/tools/index.ts` 显式注册；allowlist 从实际注册结果生成，不扫描目录自动注册，不维护第二套名单。当前工具与可选开关以注册实现和配置为准。
3. 新增网络、写入、MCP 或委托能力先设计权限与失败边界，不能因注册工具扩大权限。
4. 先核对自有 `web/` 的 renderer 与 HTTP 契约；工具名、参数、结果 JSON、事件顺序必须兼容实际 schema，不用假数据伪装已有展示能力。协议展示放适配层，按需扩展 contracts/routes/presenter。
5. 在 `src/bootstrap/create-service.ts` 显式创建并注入唯一实例，不继续堆入 conversation、HTTP app 或 session factory；纯规则与跨层验证按 [测试规范](testing.md)执行，接口/工具报文变更同时遵守 [API 开发规范](api-development.md)。

## Agent 协议与数据布局

当前契约统一使用 Agent、`agentId` 与 `agent` 工具；不提供 Space/Thread 路由、字段或读取别名。身份资料读取与保存位于 `/api/identity`，实例 Dream 位于 `/api/dream`，运行快照位于 `/api/runs/status`。

私有文件位于 `workspace/agents/<agentId>/`，会话与讨论仍归 `sessions/<agentId>/`。本次还变更持久化归属字段、指令用途标题和 PI 通信 marker；不能仅改一个目录名就打开旧数据。检测到旧 `workspace/threads/` 时，服务在任何初始化写入前拒绝启动，提示先停服并在备份上显式转换；当前没有隐式迁移器、旧读取器或自动删除。真实实例转换需要另行确认，开发验收使用新建隔离数据。
