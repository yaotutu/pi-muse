# Pi Muse 客户端接入与协作指南

> **协作分工说明（2026-11-22 起生效）**：本工作区服务端开发侧仅负责 `pi-muse-server/`（接口、核心逻辑、契约与文档），不再直接修改任何独立客户端仓库（如 `pi-muse-mobile/`、`pi-muse-flutter/`）。本文档阐述服务端期望的客户端工作模式、状态所有权与接入边界，供前端团队与前端开发 Agent 参考；**前端无需 100% 照搬本文的交互或实现细节**，可在守住硬边界的前提下按自身节奏和产品判断自主演进。

---

## 1. 协作边界：Must / Should / May 三层模型

为了兼顾服务端安全/协议正确性与前端产品自由度，本文将全部规范拆为三层：

| 层级 | 含义 | 具体范围 |
| --- | --- | --- |
| **Must（硬边界 / 协议不变量）** | 违反会导致鉴权失败、数据错乱、状态覆盖或破坏安全隔离 | 1. **凭据安全**：客户端只持久化服务地址与 Bearer Session Token；**严禁**持久化明文 `accessKey`，**严禁**将 Bearer Token 放入任何 URL query（图片、SSE、WS 均不可）。<br>2. **契约唯一权威**：精确路径、请求/响应字段、校验边界与错误码以运行实例 `GET /docs`、`GET /openapi.json` 及 `src/http/contracts/` 为准，不猜测、不另建手写规范。<br>3. **聊天提交不变量**：`POST /api/conversation/run` 不回传全量历史，必须提交 `expectedRevision` 并正确处理 `409` 版本/删除冲突。<br>4. **身份与版本合并**：严格区分 `sessionId`、`piSessionId` 与 `instanceId`；运行状态仅在同 `instanceId` 内按 `(sessionId, runId, revision)` 合并，审批按 `(id, revision)` 跨实例合并。<br>5. **文件审批与手动确认**：模型文件审批必须向用户完整展示不可变 `before`/`after` 原文并由人决定；区分 `status: "approved"`（人的授权）与 `execution.status`（真实落盘结果）。手动文件写入/创建仅在向用户完整展示并确认后才能传 `confirmed: true`，不得以此绕过模型审批。<br>6. **写入未明不重发**：除明确声明幂等的操作外，写入超时/断网必须保留草稿并先回读服务端权威状态，禁止静默自动重发。<br>7. **不可信内容隔离**：外部网页、RSS、短信、文本附件以及工作区 `kind: "text"` 中的 SVG/HTML 一律按不可信纯文本处理，禁止直接当 HTML/脚本执行。 |
| **Should（推荐工作模式）** | 服务端接口和事件流围绕这些模式设计，采用后体验与一致性最佳 | 1. **连接级单通知流**：每个服务器连接只维持一条 `GET /api/events` SSE 长连接，由连接级调度消费后分发至各模块。<br>2. **按 `ready` 整集重建**：每次收到 `ready` 首帧，整体替换本地进行中运行、待审批、进行中活动与在线状态集合，不做断线前后并集。<br>3. **聊天流与界面解耦**：切换会话或 Tab 时保持在途聊天流挂载、独立保留每会话草稿；若前端选择不保活后台流，应在切出前提醒用户或显式调用 Stop。<br>4. **失效信号防竞态**：收到 `conversation_updated` 后对对应会话标脏并重读 `GET /api/conversation`；正在流式输出时可延后到流结束后再刷，刷新请求进行中又收到新事件须补刷。<br>5. **领域通知结构化引用**：对后台领域（如 `sms`、`news`）通知卡片与新闻文章，采用统一结构化引用格式 `【领域引用:<domainId>】...【引用结束】` 追加到草稿由用户发送。<br>6. **渐进接入**：先跑通最小核心闭环（Auth + 会话 + 聊天 + `/api/events` + 审批），再按产品节奏增量接入其余领域。 |
| **May（前端完全自主空间）** | 完全由前端自行决策，服务端不做强制约束 | 1. 技术栈与跨端框架（React Native、Flutter、Web、桌面等）。<br>2. 导航层级、Tab 划分、页面组织与交互手势。<br>3. 视觉主题、配色、动效、排版与助手形象是否展示/如何展示。<br>4. 客户端状态管理方案（Store、Provider、Bloc、Signals 等）。<br>5. 纯客户端展示偏好（会话置顶分组、卡片折叠、字号、草稿本地缓存策略）。<br>6. 哪些可选业务领域（目标、Dream、浏览器控制台、追踪诊断等）是否做 UI、何时上线。 |

---

## 2. 协议事实源与前后端协作约定

### 2.1 唯一协议入口

- **可读文档**：`GET /docs`（免鉴权，Scalar 交互式文档；优先加载服务端同源 `/scalar.js`，离线失败时回退 CDN）。
- **机器可读契约**：`GET /openapi.json`（免鉴权，OpenAPI 3.1，由服务端 `src/http/contracts/` 通过 zod v4 schema 自动生成）。其中：
  - SSE 端点的每一种事件 schema 与行为说明在对应端点的 `responses["200"]["x-sse-events"]` 与 `description`；
  - WebSocket 协议（如真实浏览器视口帧流与远程桌面代理）在顶层 `x-websocket-contracts`；
  - 每个端点均含 `description` 与 `x-agent-hint`，包含调用前置条件、副作用、冲突码与同步步骤。

### 2.2 实例版本与时区核对

接入、调试或遇到异常时，先请求免鉴权的 `GET /api/health`：

- `configured`：服务端业务模型是否已配置（决定 `POST /api/conversation/run` 能否运行，未配置返回 `503`）。
- `timeZone`：服务端所在本地时区 IANA 标识（如 `Asia/Shanghai`）。每日定时任务 `daily: true` 的 `at`（`HH:mm`）按此时区解释，前端无需代算 UTC。
- `serviceVersion`：`{ version, commit, dirty, sourceHash, mode, builtAt }`（与 `/openapi.json` 顶层 `x-service-version` 一致）。
  - **关键约定**：当 `dirty === true` 或 `commit === null` 时，绝对不要仅凭 `commit` 判断运行代码是否最新，必须比对 `sourceHash`（SHA-256 源码指纹）。

### 2.3 无凭据本地联调

服务端提供内置模拟联调入口（不依赖真实大模型 Key 与外网费用）：

- 在 `pi-muse-server/` 执行 `pnpm dev:mock`：固定监听 `127.0.0.1:17891`，数据隔离在 `.pi-muse/mock/`，支持预设触发词（如时间、读文件、写入审批、`slow`、`fail-once` 等，详见 `docs/testing.md` 的 fake-model 触发词章节）。
- 注意：Mock 联调仅用于验证界面交互与协议联调，真实验收仍须对接真实后端与真实外部模型。

### 2.4 异步变更协作流程

- **服务端变更同步机制**：服务端每次调整对外 HTTP/SSE/工具契约，都会同步修改 `src/http/contracts/` 与自动文档测试，确保 `/docs` 和 `/openapi.json` 自解释；当涉及跨领域协作范式或客户端硬边界变更时，同步更新本文档并在提交/交付说明中明确列出“客户端影响（新增 / 变更 / 破坏性变更）”。
- **前端诉求反馈**：当客户端产品交互需要新端点、新字段或新的服务端语义时，直接向服务端提出契约需求；**不要**通过高频轮询、解析助手自然语言回复或客户端本地维护权威副本等方式绕过缺失契约。

---

## 3. 系统心智模型与状态所有权

Pi Muse 是**单进程、单用户、单一助手身份、多会话上下文、唯一扁平工作区**的个人助手系统：

- 只有一个助手身份，**没有**多智能体切换、群组路由或按会话隔离的私有工作区目录。
- 专题会话（`sessionId` 为 UUID）只隔离**聊天历史、草稿、运行状态、以及定时任务/监控/审批/活动的来源归属**；助手设定、技能、记忆、文件工作区、短信、新闻与浏览器是实例全局共享的。

### 3.1 状态所有权对照表

| 归属层 | 数据与状态 | 客户端职责 |
| --- | --- | --- |
| **服务端实例全局** | 模型配置、`SOUL.md` / `USER.md` / `INSTRUCTIONS.md`、技能资产与开关、长期记忆、长期目标、Dream 状态与待决项、短信原始条/批处理、新闻源/文章/偏好、唯一 `workspace/` 文件、真实 Chrome 实例、自定义助手形象包 | 按需读取与调用对应写入 REST；**不保存**模型 Key，**不维护**第二份业务事实权威副本 |
| **服务端公开会话级** | 会话元数据（标题/时间）、pi JSONL 聊天正文/附件/工具历史、消息反馈（点赞/评论）、定时任务/监控/活动/审批的归属 `sessionId` | 按 `sessionId` 读取权威历史与归属视图；不可擅自改写历史消息 |
| **服务端单次运行级** | 运行互斥锁、取消信号、内存运行状态投影（`session_status_updated`）、当轮临时审批授权 | 按 `(sessionId, runId)` 展示状态并提交 `stop` / `decision` |
| **客户端本地自有** | 服务器 Base URL、Bearer Session Token、每会话未发送草稿与待发附件、本地 UI 偏好（主题/置顶/折叠）、形象 PNG 本地缓存 | 按连接（`baseUrl` 维度）隔离存储；换服时彻底销毁连接级缓存 |

### 3.2 三个核心身份 ID（不可混用）

| ID | 含义与来源 | 生命周期与用途 |
| --- | --- | --- |
| `sessionId` | 公开会话标识：固定 `"main"` 或服务端生成的规范小写 UUID | `reset` 后保持**不变**；用于聊天接口、历史查询、会话重命名/删除与任务归属 |
| `piSessionId` | 当前绑定在会话上的 pi 历史树标识（服务端生成） | `reset` 后会**更换为新值**（空或不存在的合法会话返回 `null`）；用于消息反馈校验（防评价到已重置旧历史）与过滤迟到的 `conversation_updated` 帧 |
| `instanceId` | 产生 SSE/运行状态的服务进程 UUID | 服务端每次重启会**变化**。**注意区别**：运行状态（`session_status_updated` / `/api/runs/status`）的 `revision` 仅在单进程内存有效，`instanceId` 变化后必须清空运行版本缓存；而审批（`approval_*`）的 `revision` 跨进程持久化，**不能**因 `instanceId` 变化而重置或清空 |

### 3.3 鉴权、请求上限与错误恢复

1. **鉴权获取与传递**：
   - 调用 `POST /api/session`（Body：`{ accessKey?: string }`，服务端未配置访问密钥的回环开发部署可省略或传空对象）换取 `{ token, mode: "live" }`。
   - 该 Bearer Token 长期有效（除非服务端配置修改或清除了 `accessKey`），后续所有 `/api/*` 请求通过请求头 `Authorization: Bearer <token>` 传递（`/api/health`、`/api/session`、`/docs`、`/openapi.json`、`/scalar.js`、`/updates/android/*` 与一次性 ticket 落地入口除外）。
   - **安全红线**：客户端只持久化服务地址与 `token`，**绝不持久化明文 `accessKey`**，也不在日志/错误上报中打印 `token` 或 `accessKey`。
   - **禁止 URL 传 Token**：浏览器原生 `EventSource` 不支持自定义请求头，**不要**为图方便把 token 放进 URL query；请使用支持自定义 Header 的流式 `fetch` 读取 SSE；下载助手形象 PNG 等二进制资源同样必须走带 `Authorization` 头的请求。需要从浏览器/WebView 打开交互页时（如真实浏览器 WS 或 noVNC 桌面），先用 Bearer Token 调用接口换取 60 秒一次性 ticket。
2. **常见 HTTP 状态码约定**：
   - `401 Unauthorized`：Token 失效或未授权；提示并引导重新登录，**禁止**用无效凭据无限自动重连（尤其是 SSE）。
   - `409 Conflict`：版本冲突（聊天 `expectedRevision`）、会话正忙/正删除（`SESSION_DELETING`）、审批已进入其他终态（409 Body 会附带最新 `{ error, approval }` 完整视图）、删除会话清单过期（`SESSION_SCHEDULES_CHANGED`）或任务仍在运行（`SESSION_JOB_RUNNING`）。处理原则：**保留用户本地未成功提交的草稿**，先刷新权威状态，再由用户决策。
   - `413 Request Too Large`：通用 JSON 请求体上限为 **1 MiB**；例外：`POST /api/conversation/run` 与 `POST /api/browser/uploads/:uploadId` 上限为 **12 MiB**，`PUT /api/companions/:packId/assets/:state` 上限为 **2 MiB**。前端应在发送前按对应限额预检。
   - `503 Service Unavailable`：服务端正在优雅关闭、业务模型未配置或浏览器功能未启用；向用户明确展示不可用原因并适当退避。
3. **写入未明禁止自动重发，GET 失败禁止伪装为空**：
   - 当任何写请求（发送消息、文件保存、审批决定、删除/创建资源）遇到网络断开或超时导致结果未明时，**严禁**后台静默重试，必须保留草稿/现场并先调用对应 `GET` 接口核对服务端真实状态。
   - 仅下列接口具备服务端显式幂等语义（且有严格条件）：
     - `POST /api/conversation/run`：仅当使用**完全相同**的 `runId`、`message.id`、`content` 与相同的附件顺序及字节 SHA-256 重试同一已完成轮时，服务端会通过 `MESSAGES_SNAPSHOT` 事件幂等重放。
     - `POST /api/approvals/:id/decision`：对同一审批重复提交相同的 `approve`/`deny` 决定，幂等返回 200 原审批且不再次执行、不推进 `revision`。
     - `POST /api/information/items`：同一 `(source, externalId)` 与相同内容重复接入会幂等回读，但若内容不同会返回 `409` 且不覆盖原文。
   - 任何 `GET` 请求失败时保留界面已有有效快照并提示错误，**不要**把网络失败渲染成“空列表”。
4. **换服与迟到响应隔离**：
   - 切换服务器地址或退出当前服务器连接时，销毁该连接下所有内存 Store、SSE 连接、运行状态与缓存（包括助手形象本地缓存）。
   - 所有异步请求回包应绑定发出时的连接代次与 `(sessionId, piSessionId)`，若用户已切服、切会话或已重置历史，丢弃迟到响应。

---

## 4. 双流协作架构（核心运行模式）

服务端刻意把**全工作区状态同步**与**单轮聊天文本流**拆分为两条完全独立的 SSE 通道。这是接入 Pi Muse 最关键的设计：

| 维度 | 全局实时状态与失效流 `GET /api/events` | 单会话聊天流 `POST /api/conversation/run` |
| --- | --- | --- |
| **作用域与数量** | 连接级（整个服务器连接 **只建 1 条**，服务端单实例总并发上限 8 条，超限 429） | 会话/运行级（每会话同一时刻 1 个运行，不同会话可并行） |
| **SSE 帧格式（⚠️ 重要差异）** | 标准多字段帧：**同时发送 `event: <事件名>` 和单行 `data: <JSON>`**，末尾 `\n\n`；按 `event:` 名称分派 | 仅数据帧：**不发送 `event:` 行**，只发送 `data: <JSON>\n\n`；按解析后 JSON 的 `data.type` 分派 |
| **心跳机制** | 每 **30 秒**发送注释帧 `: keep-alive\n\n`（非 JSON，不能送入 JSON.parse） | 无独立注释心跳（流式生成期间持续推块） |
| **断连语义** | **不影响任何服务端运行**（聊天、定时任务、子代理、审批等待全部继续） | **立即中止该次 run**（触发对应 `AbortSignal`，取消模型与子代理；已产生的副作用不回滚） |
| **重放与重连同步** | 不发送 `id:`、忽略 `Last-Event-ID`；重连靠新首帧 `ready` 整集重建 + 主动回读目录与打开的会话历史 | 不重连续传同一条残流；断线或结束后从 `GET /api/conversation` 读取权威历史 |

### 4.1 全局通知流 `GET /api/events` 消费规范

1. **连接建立与异常处理**：
   - 使用支持流式读取和自定义 Header（`Authorization: Bearer <token>`）的 HTTP 客户端逐 chunk 读取，按 UTF-8 解码并按空行（`\n\n`）切分帧；过滤以 `:` 开头的注释心跳行（`: keep-alive`）。
   - 握手阶段返回 `401` 停止重连并走重登；`429`（`TOO_MANY_CONNECTIONS`）清理多余连接后退避重试；`503` 退避重试。
2. **首帧 `ready` 完整替换原则**：
   - 每条连接恰好发送一次 `ready` 作为首帧（`ready` 最大 12 MiB，单个增量事件最大 8 MiB；队列或单帧超限时服务端主动断流以促使客户端重连全量对齐）。
   - `ready` 包含：`instanceId`、`serverTime`、`sessionPresences`、`sessionStatuses`、`pendingApprovals`、`activities`。
   - **必须整体替换**客户端当前进行中的运行集合、待审批集合、进行中活动集合和头像在线状态集合，绝不与断线前本地缓存合并。未出现在 `sessionPresences` 中的会话视为空闲；当通知流处于断开状态时，会话状态为**未知**，不要渲染成空闲。
   - **重连后补读**：收到 `ready` 后，主动重读一次 `GET /api/sessions` 和当前已打开会话的 `GET /api/conversation`，恢复断线窗口内新建/改名/删会话及已落盘的通知/任务回复。
3. **版本合并与字段注意**：
   - **运行状态（`session_status_updated`）**：按 `(sessionId, runId)` 合并，**只应用严格大于本地已知 `revision` 的帧**，相等或更小直接丢弃；若帧内 `instanceId` 与本地记录不同，说明服务端已重启，**先清空运行状态与运行 `revision` 缓存**再以新 `ready`/新帧重建。运行终态（`succeeded`/`failed`/`cancelled`，`phase: null`，`endedAt` 非空）会推送一次，也可通过 `GET /api/runs/status?sessionId=...&runId=...` 查询。
   - **待审批与终态（`approval_pending` / `approval_updated`）**：按 `id` 索引并按严格更高 `revision` 合并。审批 `revision` 跨进程持久，**不能**因 `instanceId` 变化清空。`approval_pending` 直接包含完整不可变 `preview`，收到即可展示并供用户决定；`approval_updated` 省略了 `title`、`kind`、`preview` 以避免重复推大正文，若本地没有完整预览或收到未知 `id`，按需回读 `GET /api/approvals/:id`。
   - **活动（`activity_updated`）**：仅在 `status` 跳变时推送（过程性 `progress` 文本更新不推），按 `id` 整体覆盖本地概览；查看逐步明细或全部历史分别调用 `GET /api/activities/:id` 和 `GET /api/activities`。
   - **会话头像在线态（`session_presence_updated`）**：同一连接按到达顺序覆盖，优先级规则由服务端维护（等待用户 > 错误 > 工作中）；`lastActiveAt` 仅用于会话列表头像排序，不用于版本比较。不要使用 `serverTime`/`updatedAt` 排序或用事件数量计数业务操作。
4. **失效信号与防竞态刷新**：
   - `session_directory_updated`：重读 `GET /api/sessions`。
   - `conversation_updated`：仅携带 `{ instanceId, sessionId, piSessionId }`，不含消息正文。收到后核对 `instanceId`：
     - 对当前展示中的会话：若该会话此刻正在跑聊天 SSE 流，先打“历史待刷新”脏标记，等本轮流收尾后再读 `GET /api/conversation`；否则立即读取。**如果一次 `GET /api/conversation` 请求尚未返回期间又到达新的 `conversation_updated`，必须在这次请求完成后立刻补读一轮**，避免漏掉新消息。
     - 对后台未激活会话：可仅保留脏标记，待用户切回该会话时再读取权威历史，节省请求。
     - 当返回的 `piSessionId` 与本地视图旧值不同（说明远端发生了 reset），丢弃旧消息缓存与旧反馈状态并替换为新历史。

### 4.2 单会话聊天流 `POST /api/conversation/run` 消费规范

1. **请求结构**：
   - 提交 `{ sessionId, runId, expectedRevision, message: { id, content, attachments? } }`。不回传历史消息；新空会话的 `expectedRevision` 为 `"empty"`。
   - `attachments` 最多 4 项，随该消息一次性提交（无独立文件上传接口）：支持 `image/png`、`image/jpeg`、`image/gif`、`image/webp` 与严格 UTF-8 文本（PDF/Office/压缩包等其他二进制拒绝；SVG/HTML 作为文本处理；单图及原始总字节、文本字节限制以 `/docs` 契约为准，整条请求体上限 12 MiB）。
2. **事件顺序与工具渲染**：
   - 正常序列：`RUN_STARTED` → 多组交替的 `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT*` / `TEXT_MESSAGE_END` 与 `TOOL_CALL_START` / `TOOL_CALL_ARGS*` / `TOOL_CALL_END` / `TOOL_CALL_RESULT` → 终态二选一（`RUN_FINISHED` 或 `RUN_ERROR`）。同成功 `runId` 幂等重放路径会发出 `MESSAGES_SNAPSHOT`。
   - `TOOL_CALL_START.toolCallName` 用于前端卡片匹配渲染；受控/隐藏策略下的工具可能不发送增量参数甚至整组工具事件，且 `TOOL_CALL_RESULT.content` 已由服务端脱敏/摘要，前端直接按契约渲染即可。
   - **重要**：本流只包含主助手执行输出，子代理（`subagent`）和底层模型思维过程不会把内部原始流嵌套进来。
3. **停止（Stop）与收尾**：
   - 需要主动中断生成时，调用 `POST /api/conversation/stop` 并同时携带 `{ sessionId, runId }`（精确绑定本轮，迟到请求不会误伤下一轮），等待 `stop` 与当前流收尾后回读一次 `GET /api/conversation` 对齐服务端实际持久化结果（如部分已执行的工具消息或通知）。
   - 客户端主动断开 HTTP 连接也会立即取消服务端执行，但已完成或同步提交的副作用（如已写入的记忆/SQL 数据）不会回滚。
4. **多会话体验建议**：
   - **强烈建议**：像“会话宿主容器”模式一样，保持已打开会话的聊天流与未发送草稿按 `sessionId` 驻留，切换会话或切到新闻/设置 Tab 只切 UI 可见性而不卸载底层 SSE 读取；若特定轻量端选择切出即销毁页面，则在离开正在生成的会话前应先提示用户或显式调用 `stop`，避免无意断流取消模型。

---

## 5. 按领域接入指南（核心层 → 安全层 → 可选扩展层）

推荐按以下分阶段路线接入，前端可随时在任意阶段交付可用版本：

- **阶段 1（最小闭环）**：Health / Auth + 会话管理 + 聊天流 + `/api/events` + 模型文件审批。
- **阶段 2（安全增强与消息体验）**：工具卡片与运行状态面板 + 手动工作区文件管理 + 消息反馈（点赞/评论）。
- **阶段 3（全局后台域与工具集成）**：后台领域 Agent（短信 / 新闻）+ 执行活动 + 定时任务/监控 + 长期目标/记忆/Dream + 助手形象包 + 共享真实浏览器 + Android 更新镜像。

### 5.1 会话生命周期（`/api/sessions*`）

- `main` 会话首次启动即存在，标题固定为“默认会话”，排在列表第一位，**不可删除，可重置**；其余专题会话按 `updatedAt` 倒序排列，由服务端生成 UUID。
- **重置（`POST /api/sessions/:sessionId/reset`）**：取消在途运行与待审批、清空 pi JSONL 与消息反馈，保留公开 `sessionId`、标题、定时任务/监控和全局助手设置，但 `piSessionId` 会换新；不可恢复，操作前应由用户明确确认。
- **两步删除专题会话**：
  1. 先调用 `GET /api/sessions/:sessionId/schedules` 获取该会话名下全部定时任务/监控清单及 `scheduleRevision`。
  2. 在确认框让用户选择 `scheduleDisposition`（`"delete"` 一并删除，或 `"move-to-main"` 保留并迁移到 `main`），再携 `scheduleRevision` 调用 `DELETE /api/sessions/:sessionId`。
  3. 若返回 `409 SESSION_SCHEDULES_CHANGED`（预览期间清单变化）或 `409 SESSION_JOB_RUNNING`（选择保留但原会话任务仍在跑），刷新清单或等待运行结束后再由用户确认。

### 5.2 运行状态与安全工具展示（`/api/runs/status` & `session_status_updated`）

- `session_status_updated` 中的 `phase` 为 `preparing` / `waiting_model` / `responding` / `executing_tool` / `waiting_subagents` / `waiting_approval` / `finalizing`（终态为 `null`）。普通闲聊或简单问答没有关联 Activity（`activityId: null`）属于正常情况。
- `tools[]` 中每项含 `{ toolCallId, name, label, status, subagentId }`。**受控或隐藏工具的 `name` 会显式输出 `null`**，此时 UI 必须展示服务端提供的 `label`，切勿把 `name === null` 判定为报错或缺失字段。

### 5.3 模型文件审批与手动工作区文件（强安全契约）

这两条链路共享服务端写提交队列，但**权限语义绝不能混用或互绕**：

1. **模型文件审批（`/api/approvals*` + `/api/events`）**：
   - 待审批项由 `ready.pendingApprovals` 和 `approval_pending` 推送完整视图（含 `title`、`kind`: `file_write` | `file_edit`、`expiresAt` 与不可变 `preview: { scope, path, before, after, beforeExists }`）。
   - **展示要求**：必须把 `preview.before` 与 `preview.after` 全文完整展示给用户核对（不得截断、不得只显示片段摘要、也不得用读取当前磁盘文件来替代历史登记时的 `preview`）。`scope` 为 `"workspace"` 或 `"skill"`（实例技能文本）。
   - **提交决定**：只能由用户显式点击后调用 `POST /api/approvals/:id/decision`（Body 仅 `{ decision: "approve" | "deny" }`）。如遇 `409`，用响应携带的 `approval` 更新本地视图。
   - **区分授权与落盘**：`status === "approved"` 仅代表“人已同意执行这一次绑定版本的预览操作”，**绝不代表文件已写入成功**！是否真正落盘必须观察 `execution` 字段（通过 `approval_updated` 或 `GET /api/approvals/:id` 获取）：
     - `execution === null`：尚未观察到执行；
     - `execution.status`: `"running"`（提交中）、`"succeeded"`（写入成功）、`"failed"`（失败，如文件版本已被外部修改或过期）、`"cancelled"`（运行被取消）、`"unknown"`（如写入中途进程中断，结果未知）。
     - 若出现 `"unknown"`，前端应如实提示用户先查看工作区文件核对结果，不要自动重发。
   - 审批历史分页使用 `GET /api/approvals`（只含终态摘要，无 `preview` 正文，需要看全文时查 `GET /api/approvals/:id`）。
2. **手动工作区文件管理（`/api/workspace/files*`）**：
   - 所有会话共用唯一扁平工作区（`workspace/`），接口不接受会话/根选择器，`path` 全部相对该根（根目录列表传 `.`）。
   - 读取详情 `GET /api/workspace/files/content` 会区分 `kind: "text" | "image" | "binary"`（`image`/`binary` 返回 `dataBase64`）。**安全要求**：SVG 与 HTML 文件服务端会按 `kind: "text"` 原样返回，客户端必须按不可信纯文本渲染或预览代码，**禁止当成可执行网页/脚本渲染**。
   - 新建（`POST /api/workspace/files/text`）或更新（`PUT /api/workspace/files/text`）文本时，服务端要求 Body 必填 `confirmed: true`。客户端必须在界面向用户完整展示待写入内容（更新时展示 `before`/`after` 对比）并得到用户明确保存确认后才提交，不得默认静默填充 `confirmed: true`。最后一次成功保存生效，写入只允许安全 ASCII 相对路径字符集（详情见 `/docs`）。

### 5.4 后台领域 Agent（`sms` / `news` 及后续扩展领域）

服务端采用「**单一主助手 + 多个独立后台领域 Agent**」架构：

- **规则板与隔离原则**：每个领域 Agent 拥有独立提示词、独立用户显式规则板 `notes`（保存即覆盖，与工作区 `workspace/domains/<id>/RULES.md` 同步）以及模型根据反馈沉淀的只读自学习画像 `learnedNotes`（不可覆盖 `notes`）。后台领域 Agent **不读取**主聊天技能、`INSTRUCTIONS.md` 或全局 `memory`。在主聊天中，用户提到领域过滤/偏好时，主助手会调用 `domain_agent` 工具协同查询或提议更新对应领域规则（更新规则仍走模型文件审批）。
- **主聊天通知隔离与结构化引用约定（推荐模式）**：
  - 后台重要通知会由服务端写入 `main` 会话历史，该消息带有可靠元数据：`metadata.source === "notification"`、`metadata.notificationId` 以及 `metadata.domainId`（如 `"sms"`、`"news"`）。
  - 服务端在每次送入主模型上下文前，**默认过滤掉所有带 `domainId` 的通知卡片**，避免零碎通知污染主对话。
  - 当用户在前端选中某条领域通知卡片“引用并提问”，或从新闻页点击“在聊天中讨论”时，推荐按统一结构化格式将该内容作为不可信引用**追加到当前会话草稿**（不要自动替用户发送，由用户补充意图后再发送）：
    ```text
    【领域引用:<domainId>】
    ...（引用标题/时间/摘要或正文片段）...
    【引用结束】
    ```
  - 发送后，主助手即可在当轮上下文看到这段引用，并能准确将后续规则改动通过 `domain_agent` 路由到对应领域。
- **短信后台（`/api/information/*`）**：
  - 开关（默认关闭）与聚合窗口（`batchWindowSeconds`，0–3600）由 `/api/information/settings` 管理；偏好与自学习例证由 `/api/information/preferences` 管理。
  - 接入原始信息调用 `POST /api/information/items`（单批最多 500 条），以 `(source, externalId)` 为幂等键。批量上传历史短信分片时建议传 `bulkImport: true`，避免增量定时调度在分片途中抢跑；导入完成后调用 `POST /api/information/runs`（可配 `background: true`、`forceInitial: true`）触发首轮全量建画像分析，并通过 `GET /api/information/status` 轮询队列进度直至 `running === false`。
- **新闻阅读与推荐（`/api/news/*`）**：
  - 支持 RSS 源列表/添加/停止采集（删除源后已接纳的文章、收藏、反应与评论**继续保留**，仅停止后续采集；添加源 400 失败会附带受控 `failure.category`）。
  - 文章支持 `view=all|recommended` 与 `savedOnly=true|false` 游标分页；`POST /api/news/refresh` 需传严格空 JSON 对象 `{}`（不等待模型筛选结束，前台可短时观察 `GET /api/news/status` 直至 `refreshing` 和 `processing` 均为 `false` 后停表并刷新列表）。
  - 逐篇反馈（`reaction` 喜欢/不喜欢、`saved` 收藏、`comments` 评论）独立持久在新闻域内，不写入聊天历史，也不会因 `main` 会话 reset 被清空。

### 5.5 其他可选领域与通用规则

- **执行活动（`/api/activities*`）**：完全只读。活动仅在主模型主动推进用户交办的工作时显式登记，普通对话没有活动是预期行为。`status === "awaiting_continuation"` 表示本轮停止但任务未完结，需由用户在对话中明确要求继续（模型会继续更新原活动）。
- **定时任务与网页监控（`/api/jobs*`、`/api/monitors*`）**：
  - 绑定创建时的 `originSessionId`（省略默认 `main`），支持暂停/恢复/取消/重试/修改。
  - **时区规范**：当 `daily === true` 时，`at` 必须为严格 24 小时制两位 `HH:mm`（如 `"09:00"`），服务端按 `GET /api/health.timeZone` 解释，客户端在同地区使用可直接填本地时刻无需自行换算；当 `daily === false` 时，`at` 需为带时区偏移的 ISO 8601 时间戳（如 `"2026-10-22T09:00:00+08:00"`）。`nextRunAt` 统一返回带 `Z` 的 UTC ISO 8601。
- **消息反馈（`/api/sessions/:sessionId/messages/:messageId/feedback*`）**：
  - 仅 `metadata.feedbackAvailable === true` 的 `user` 或 `assistant` 消息可设置互斥 `like`/`dislike` 或多条评论（`tool` 消息与正在生成中的流式占位消息不可反馈）。
  - 请求必须带上当前 `piSessionId`；若会话已重置，服务端返回 `409`。
- **长期目标、记忆与 Dream（`/api/goals*`、`/api/memories*`、`/api/dream*`）**：
  - 均为实例全局管理。激活态目标（`active`）会摘要注入每轮对话；长期记忆上限 500 条（满额返回 `409`）按需被模型检索；Dream 每两小时整理一次对话并产出待决建议（`pending`），调用 `POST /api/dream/pending/:pendingId` 应用（`apply`）或丢弃（`dismiss`）时即使建议来自已删专题会话，也只写入全局目标，绝不借此重建已删会话。
- **游标分页通用规范**：
  - 适用于审批历史（`/api/approvals`）、活动（`/api/activities`）、信息条目/run（`/api/information/items|runs`）、新闻文章（`/api/news/articles`）和模型追踪（`/api/traces`）。
  - `cursor` / `nextCursor` 是绑定了当次过滤条件的不透明字符串，翻页时原样回传即可；**只要切换了任何过滤参数，必须清空旧 `cursor` 从第一页重新拉取**，否则会返回 `400`。此类分页不冻结快照，新增项出现在第一页。
- **助手形象包（`/api/companions*`）**：
  - 纯客户端展示资源，不进入模型上下文。每个完整包固定包含 8 个状态 PNG，顺序与名称为：`idle`、`thinking`、`responding`、`working`、`waiting-approval`、`success`、`error`、`stopped`。
  - 拉取包列表 `GET /api/companions` 后按 `version` 校验缓存，通过 `GET /api/companions/:packId/assets/:state`（带 Bearer Token 头，不可放 URL）下载 PNG 并核对 `ETag`。若服务端包被删除/损坏或切换服务器，客户端安全回退到内置形象；切换形象时不要重建整个连接宿主或断开 SSE。
- **共享真实浏览器（`/api/browser/*`、`/ws/browser`、`/browser/desktop/*`）**：
  - 用户与产品助手共享同一个服务端懒启动的可见 Chrome，关闭客户端浏览窗口不会关闭后端 Chrome。
  - 先查 `GET /api/browser/status` 确认 `enabled` 与 `desktopAvailable`。
  - **视口帧流方式**：调用 `POST /api/browser/ws-ticket` 换取 60 秒一次性 ticket，连接 `ws(s)://<host>/ws/browser?ticket=<ticket>`。服务端发送二进制帧格式为：`4 字节大端无符号整数 metadataLength` + `UTF-8 JSON metadata` + `JPEG 图片字节`。客户端每绘制完成一帧，必须发送 `{ type: "frame_ack", frameId, sessionId }` 配合流控（慢客户端会被跳帧，积压超 2 MiB 会断连）。交互输入指令见 OpenAPI `x-websocket-contracts.browser`。
  - **远程桌面 noVNC 方式**：调用 `POST /api/browser/desktop-ticket` 获取一次性 `launchPath`（60 秒有效），在受控 WebView 中以同源完整地址打开，服务端签发 `Path=/browser/desktop/` 的 HttpOnly 会话 Cookie 并 303 重定向至 `/browser/desktop/vnc.html`（注意其配套 websockify 校验同源 Origin，TLS 终止反代下需注意 Origin 一致性）。
  - **上传与下载**：页面触发的待处理 `filechooser` 和持久化下载通过 `GET /api/browser/files` 获取，分别由用户明确选文件后调用 `POST /api/browser/uploads/:uploadId` 或 `GET /api/browser/downloads/:downloadId/content` 处理。
- **Android 更新镜像（`/updates/android/*`）**：
  - 免业务鉴权，仅原生 Android 客户端检查与下载 APK 更新时按需接入。

---

## 6. 前端联调与上线自查清单

在将客户端对接或发版前，建议逐项核对以下检查项：

- [ ] **版本核对**：已读取 `GET /api/health`，确认服务端 `configured`、`timeZone` 与 `serviceVersion.sourceHash` 匹配当前联调目标，并以该实例的 `/docs`、`/openapi.json` 为字段准绳。
- [ ] **凭据与隔离**：本地仅保存服务器地址与 Session Token，无明文 `accessKey` 落盘；URL query 中无长期 Bearer Token；切换服务器时已彻底销毁连接状态、SSE 与形象缓存。
- [ ] **双流解耦**：整个连接只建立 1 条 `GET /api/events`（按 `event:` 分派、过滤 `: keep-alive`、断线重连后用 `ready` 整集覆盖并重读目录和打开的会话）；聊天使用 `POST /api/conversation/run`（按 `data.type` 分派，断开即取消，切会话不断流或切出前显式确认/停止）。
- [ ] **冲突与幂等**：聊天 `409` 时未丢弃用户草稿；任何写入超时或中断未直接盲目重发，而是先回读核对服务端事实。
- [ ] **审批安全闭环**：模型审批完整展示了 `before`/`after` 原文且仅由人工触发决定；界面清晰区分了“已批准（`approved`）”与“实际写入状态（`execution.status`）”；手动工作区写文本前明确展示并取得用户确认后才传 `confirmed: true`。
- [ ] **不可信内容防护**：工作区中的 SVG/HTML、外部新闻摘要、短信正文及网页标题均按纯文本/沙箱隔离呈现，未直接作为可信脚本/HTML 注入执行。
- [ ] **分页与迟到保护**：切换任何列表筛选条件时已重置 `cursor`；异步回包已按连接代次及 `(sessionId, piSessionId)` 过滤旧请求。
