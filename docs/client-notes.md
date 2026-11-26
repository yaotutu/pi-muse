# Pi Muse 服务端接入须知与变更记录（Client Notes）

> **本文用途**：服务端在持续演进过程中，每当产生**需要外部接入端注意的事项**（如新增可接入能力、行为/状态码调整、破坏性变更、易踩坑边界或对受限/无屏端的影响），由服务端 Agent 顺手记在此处。**无外部影响的重构或内部修复不记入**，避免流水账。

## 给接入端 Agent（怎么读）

1. **先明确自身形态**：先阅读 [客户端接入与协作指南](client-integration-guide.md)，判断当前接入端属于 `webhook`（无头/投喂）、`embedded-voice`（ESP32/智能音箱/CLI 等轻量对话端）还是 `rich-ui`（手机/Web/桌面富交互端），只接入自身需要的能力集。
2. **按标签筛选下方条目**：结合条目的**影响端形态**（`all` / `rich-ui` / `embedded-voice` / `webhook`）与**类型**（`breaking` / `feature` / `behavior` / `caveat`）核对是否影响自己的接入逻辑。
3. **以运行时契约为准**：精确路径、请求/响应字段、校验边界与错误码一律以目标实例免鉴权的 `GET /docs`、`GET /openapi.json` 及 `GET /api/health`（特别是 `serviceVersion.sourceHash`）为唯一事实源。
4. **反向提需求 / 查看留言**：需要服务端新增接口、调整字段或上报协议问题时，统一向工作区根目录中立收件箱 `client-requests.md` 按 `REQ-YYYYMMDD-NN` 模板追加诉求（不直接修改 `pi-muse-server/` 文件；独立环境可输出同格式文本交由用户转贴）；同时可顺便查看该收件箱中服务端留给对应项目的 `NOTE-*` 留言并自主决定处理或忽略。

## 给服务端 Agent（怎么记）

- **何时记录**：仅当本次服务端改动涉及以下情况时追加记录——
  - `breaking`：端点下线、字段/事件名/状态码/语义变化或破坏性校验收紧；
  - `feature`：新增可供外部接入端调用的能力或新端形态入口；
  - `behavior`：默认行为、分页/排序、超时/过期、时区或幂等条件调整；
  - `caveat`：多形态接入端（尤其嵌入式/语音/无头端）极易踩坑的协议细节或交互边界。
- **不要记录**：纯内部重构、未改变对外协议的 bug 修复、测试与文档排版调整，以及针对单个其他项目的建议或旧/无用文件提醒（这类非契约类跨项目留言请写入工作区根目录收件箱 `client-requests.md` 的 `NOTE-*` 区块，写完即止，其余不管）。
- **不要抄写 Schema**：写清楚“变了什么、哪类端受影响、接入端要注意什么、去 `/docs` 哪里查精确定义”，禁止手抄 JSON Schema 或字段清单。
- **倒序维护与定期清理**：新条目插在下方列表最顶部；已被后续变更覆盖，或已完全沉淀进 `/docs` 与 [client-integration-guide.md](client-integration-guide.md) 的长期稳定条目，必须立即清理或直接改写为最新事实，禁止保留失效旧表述再打括号补丁，保持文档精炼。

### 记录模板

```markdown
### YYYY-MM-DD — <简短主题>

- **影响端形态**：`all` / `rich-ui` / `embedded-voice` / `webhook`（可多选）
- **类型**：`breaking` / `feature` / `behavior` / `caveat`
- **契约入口**：`/docs` 对应分组或具体路径
- **要点与接入端注意**：
  - ...
```

---

## 变更与须知记录

### 2026-11-26 — 聊天断流改为后台续跑，新增重挂流 `GET /api/conversation/stream` 与 `lastRun`

- **影响端形态**：`all`（重点影响 `rich-ui`、`embedded-voice`）
- **类型**：`behavior`、`feature`
- **契约入口**：`/docs`「会话」（`POST /api/conversation/run`、`GET /api/conversation/stream`、`GET /api/conversation`）
- **要点与接入端注意**：
  - **聊天 SSE 断流不再取消服务端运行**：客户端调用 `POST /api/conversation/run` 提交消息并开始执行后，主动或被动断开该 HTTP 连接（切后台、锁屏、杀进程、网络切换）仅解除本次流订阅，服务端会继续在后台完成推理、工具与子代理调用并持久化历史。仅显式 `POST /api/conversation/stop`、单轮超时、会话重置/删除或服务关闭会取消运行。
  - **新增断线重挂流端点 `GET /api/conversation/stream?sessionId=...&runId=...`**：重连或回到前台时可按运行身份重新订阅正在执行的 AG-UI 聊天流；连接成功会先补发 `RUN_STARTED` 与当前轮已累积文本快照，再实时推送后续增量直到 `RUN_FINISHED` 或 `RUN_ERROR`。若运行已结束或不存在则返回 `404`，客户端改读 `GET /api/conversation`。
  - **`GET /api/conversation` 新增 `lastRun` 字段**：返回当前进行中或最近一次已结束运行的展示状态快照（`SessionStatus | null`），便于客户端冷启动后立即区分「仍在运行 / 已完成 / 已失败 / 已取消」（其中单轮超时在 `lastRun` 中记为 `status: "failed"`，并带超时提示文案）。
  - **用户消息落盘即发 `conversation_updated`**：本轮用户消息写入后即触发一次 `conversation_updated`，冷启动或另一端中途拉取历史可立即看到用户消息。

### 2026-11-25 — 彻底移除 `domain` 概念，统一收口为 `subagent` 并新增只读检视接口 `/api/subagents`

- **影响端形态**：`all`（重点影响 `rich-ui`）
- **类型**：`breaking`、`feature`
- **契约入口**：`/docs`「Subagents」「习惯」「工作区通知流（SSE）」「消息反馈」与「工作区文件」
- **破坏性变更对照表（前端按表替换即可）**：
  1. **SSE 事件重命名（`GET /api/events`）**：
     - 旧：`event: domain_updated`，载荷 `{ instanceId, domain, scope }`
     - 新：`event: subagent_updated`，载荷 `{ instanceId, subagentId, scope }`
  2. **习惯接口字段与路径参数重命名（`/api/habits/*`）**：
     - 路径参数：`/api/habits/:domain` → `/api/habits/:subagentId`（实际 URL 仍为 `/api/habits/sms`、`/api/habits/news`）
     - `GET /api/habits` 响应：`{ domains: [...] }` → `{ subagents: [...] }`，每项字段 `domain` → `subagentId`
     - `GET /api/habits/:subagentId` 与 `POST /api/habits/:subagentId/consolidate` 响应：顶层字段 `domain` → `subagentId`，`habits[].domain` → `habits[].subagentId`
     - `POST/PATCH /api/habits/:subagentId` 响应：`habit.domain` → `habit.subagentId`
  3. **消息元数据与通知可见性**：
     - 消息元数据字段（`GET /api/conversation`、`GET /api/sessions/:sessionId/messages/feedback` 等）：`metadata.domainId` → `metadata.subagentId`
     - 推入主聊天窗口的通知消息已取消对主模型的隐藏过滤，主模型直接可见，不再依赖强制引用格式才能参与对话。
  4. **工作区指令文件路径变更**：
     - `domains/sms/INSTRUCTIONS.md` → `subagents/sms/INSTRUCTIONS.md`
     - `domains/news/INSTRUCTIONS.md` → `subagents/news/INSTRUCTIONS.md`
     - （注：`GET/PUT /api/information/preferences` 与 `GET/PUT /api/news/preferences` 端点路径与字段名均不变，服务端内部已指向新路径；仅工作区文件页与审批预览 `path` 变为 `subagents/...`。）
- **新增能力与清理**：
  - **新增只读检视接口**：开放 `GET /api/subagents` 与 `GET /api/subagents/:id`，完整展示 5 个专职 Subagent（`sms`、`news`、`browser`、`habits`、`dream`）的触发入口（`chat`/`background`）、启用状态、纯函数策略、各自维护的 `routingHint`、内置系统提示词原文、关联用户指令/习惯快照，以及静态绑定的 `tools`、`skills`、`mcp`（预留槽位）和可编辑性元信息。
  - **内置技能清理**：移除过时的内置 `task` 技能（以及旧编程风角色 `scout/planner/reviewer/worker`）与旧 `domain_agent` 工具；主聊天默认通过统一 `subagent` 工具向 `sms`、`news`、`browser` 路由任务。

### 2026-11-24 — 真实浏览器操控页视觉重做：手机端不再自动切换共享视口

- **影响端形态**：`rich-ui`
- **类型**：`behavior`
- **契约入口**：`/docs`「浏览器」（`GET /browser` 返回的响应式操控页；协议本身未变）
- **要点与接入端注意**：
  - **共享视口不再被手机端自动劫持**：此前手机窄屏打开 `/browser` 会自动把**全局共享**视口切成手机尺寸，导致同期的电脑端画面突然变小（看起来像“地址栏消失”）。现在窄屏打开只显示一条提示条说明当前共享视口尺寸，**只有用户主动点击提示条或视口切换按钮**才会真正改变视口。接入端若自行实现了“窄屏自动切视口”，请一并移除该行为，保持与服务端操控页一致。
  - **操控页视觉与文案重做**：浅色产品风格、地址栏独占整行并带协议安全标记、状态胶囊改为「已连接 · 桌面 1280×800」这类人类可读文案（帧号降级为次要文案），加载态改为旋转指示 + 文案。协议、字段与端点均未变化，仅页面呈现与默认交互行为改变。
  - **视口切换仍是全局副作用**：任何一端切换视口，所有连接端与助手工具看到的画面尺寸都会同步变化（既有语义不变）。

### 2026-11-24 — 真实浏览器新客户端接入与视口切换后不再出现空白画布

- **影响端形态**：`rich-ui`
- **类型**：`bugfix`
- **契约入口**：`/docs`「浏览器」（WebSocket 帧流协议见 `x-websocket-contracts.browser`）
- **要点与接入端注意**：
  - **空白画布根因已修复**：静态页面不会持续触发 CDP screencast 重绘，此前存在两种“打开后一片空白”的场景——①新客户端接入时服务端没有可复用的缓存帧；②视口切换清空缓存后，客户端先收到旧尺寸帧再被清空，而新尺寸帧不一定到达。
  - **服务端行为变化**：新客户端接入且无缓存帧时，服务端会主动抓取一帧当前画面并广播；视口切换期间会丢弃旧尺寸帧，切换完成后立刻补发一帧新尺寸画面。**接入端不需要再自行实现“空白时重试/轮询”兜底**，但仍应按 `frame_ack` 协议回执以保持流控。
  - **二进制帧元数据不变**：`uint32be metadataLength + UTF-8 JSON metadata + JPEG bytes` 与 `{ type: "frame_ack", frameId, sessionId }` 交互方式均未变化。

### 2026-11-24 — 真实浏览器 Clean Break 重构（移除 noVNC 网关，统一 `/browser` 操控与新增视口/接管协议）

- **影响端形态**：`rich-ui`
- **类型**：`breaking`、`feature`
- **契约入口**：`/docs`「浏览器」「事件与通知」、顶层 `x-websocket-contracts.browser`（以 `/openapi.json` 为准）
- **要点与接入端注意**：
  - **已移除旧 noVNC 桌面网关**：下线 `POST /api/browser/desktop-ticket`、`GET /browser/desktop/launch`、`/browser/desktop/*`、配置字段 `tools.browser.desktopPort`/`desktopHost` 以及 `GET /api/browser/status` 中的 `desktopAvailable`/`desktopPath`；OpenAPI 的 `x-websocket-contracts.browserDesktop` 同步移除。
  - **推荐统一 `/browser` 免密启动入口**：用 Bearer Token 调用 `POST /api/browser/viewer-ticket` 获取 10 分钟有效的一次性 `launchPath`（`/browser/launch?ticket=...`），在 WebView/浏览器同源打开后服务端签发仅限 `/api/browser/*`（不含 `viewer-ticket`）的 `HttpOnly; SameSite=Strict` 会话 Cookie 并 `303` 重定向到 `/browser`（HTTP/HTTPS 均适用）。
  - **状态、动态视口与人工接管（Handoff）新接口**：
    - `GET /api/browser/status` 改为返回 `enabled`、`running`、`viewerPath`、`tabsCount`、`activeTabId`、`viewport`、`pendingUploadsCount`、`downloadsCount`、`handoff`（查询不会触发 Chrome 懒启动）。
    - 新增 `PUT /api/browser/viewport`（及 `/ws/browser` `viewport` 双向消息）在 `desktop` / `mobile` / `custom` 视口与触控模拟间动态切换。
    - 助手遇到登录/扫码/验证码调用 `browser` `request_handoff` 时，`GET /api/events` 新增 `browser_updated`（`scope: "handoff" | "tabs" | "viewport" | "files" | "lifecycle"`）且 `/ws/browser` 实时推送 `handoff` / `files`；用户完成后调用 `DELETE /api/browser/handoff` 通知继续。
  - **聊天 `browser` 工具合并（仅 `summary` 卡片展示影响）**：原 `navigate` / `snapshot` / `act` / `tab` 合并为单一工具 `browser`（摘要统一为 `已执行浏览器操作`）。

### 2026-11-24 — 短信归档/实时批次内容审核自动二分隔离与非阻塞简报

- **影响端形态**：`rich-ui`、`webhook`
- **类型**：`behavior`
- **契约入口**：`/docs`「信息后台」（以 `/openapi.json` 为准）
- **要点与接入端注意**：
  - **多条目批次被上游模型内容安全审核拒绝（如 MiniMax 422 input new_sensitive）时自动二分隔离**：实时与归档批次均会把真正触发审核的单条短信隔离为 `failed`（run 的 `model.error = "MODEL_CONTENT_REJECTED"`），同批其余短信正常处理、正常沉淀习惯，不再被整条批次拖垮；瞬时/全局故障（网络、5xx、无效结果）仍整批失败并阻断简报。
  - **归档简报不再被孤立的审核拒绝永久阻断**：当归档队列 `pending=0` 且剩余失败全部来自内容审核确定性拒绝时，`POST /api/information/archive/run` 仍会生成并投递 <= 1200 字中文简报，自然告知被跳过的条数，响应可能 `status: "partial"` 且 `briefingPublished: true`；存在任何非审核类失败时仍阻断，可用 `retryFailed: true` 重跑。

### 2026-11-23 — 领域偏好/习惯契约对称化、短信 SQLite v4 决策投影、`include:` 诊断与 `domain_updated` 事件

- **影响端形态**：`rich-ui`、`all`
- **类型**：`breaking`、`feature`
- **契约入口**：`/docs`「习惯」「信息后台」「新闻」「助手设置」「事件与通知」（以 `/openapi.json` 为准）
- **要点与接入端注意**：
  - **严格解析器必改预警（P0 — 偏好与习惯接口重构）**：
    - `GET / PUT /api/information/preferences` 与 `GET / PUT /api/news/preferences` 统一返回完全对称的结构：`{ instructions, includes, habits, unconsolidatedFeedbackCount }`；移除 `learnedNotes: string` 与短信侧冗余的 HTTP `feedbackExamples` 字段。
    - `GET / PUT /api/assistant/instructions` 返回 `{ instructions, includes }`；其中 `includes` 为顶部 YAML Frontmatter `include:` 的只读解析诊断数组（`path`、`status: loaded | missing | invalid | cycle | depth_exceeded | truncated | empty`、可选 `resolvedPath`），接口继续保持与保存原始文本。
  - **通用习惯管理新增域发现与待归纳明细（`/api/habits` & `/api/habits/:domain`）**：
    - 新增 `GET /api/habits`，返回全部已注册领域摘要 `{ domains: [...] }`（含 `domain`、`name`、`summary`、`running`、`habitsCount`、`unconsolidatedCount`、`autoThreshold`、`intervalMs`、`lastRunAt`、`lastRunStatus`）。
    - `GET /api/habits/:domain` 新增 `name`、`summary` 与 `pendingSignals`（热缓冲中待归纳反馈摘要，含 `targetId`、`kind`、`summary`、`reaction`、`saved`、`comments`、`commentsTruncated`、`updatedAt`），便于前端统一展示短信与新闻待消化反馈；习惯 CRUD 与手动归纳 `POST /api/habits/:domain/consolidate`（传 `{}`）继续由本组端点负责。
  - **信息后台条目直接投影判定结果与实时失败重试**：
    - `GET /api/information/items` 与 `GET /api/information/items/:itemId` 对已评估条目直接返回可选字段 `decision`（`"silent" | "notify"`）与 `reason`（模型给出的筛选理由），客户端无需再关联 `runs` 手动拼装列表展示原因。
    - `POST /api/information/runs` 支持传 `{}` 或可选 `{ retryFailed?: boolean }`（默认 `false`），允许手动立即重试日常实时队列中的 `failed` 条目。
  - **新增工作区领域失效事件 `domain_updated`（`GET /api/events`）**：
    - `GET /api/events` 新增 `domain_updated` 事件，载荷 `{ instanceId, domain, scope }`（`scope` 为 `items | runs | habits | preferences | settings`）；接入端收到后按对应 `domain` 与 `scope` 定向刷新视图，无需高频轮询。

### 2026-11-23 — 消息反馈新增 `saved` 收藏原语与条件列表接口，底层迁移至 `main.sqlite`

- **影响端形态**：`rich-ui`、`all`
- **类型**：`feature`（对严格字段白名单解析器为 `breaking`）
- **契约入口**：`/docs`「消息反馈」（以 `/openapi.json` 为准）
- **要点与接入端注意**：
  - **严格解析器必改预警（P0）**：`MessageFeedback` 返回体（含历史 `messages[].feedback`）新增必填字段 `saved: boolean`，原始事件流新增 `saved_changed` 事件类型。使用严格字段白名单（如 `hasOnlyKeys`）或详尽 `type` 枚举校验的客户端（例如 React Native 端 `parseMessageFeedback` / `parseFeedbackEvent`），**必须先适配新增字段与事件类型**，否则拉取历史和事件流会报错拦截。
  - **全消息类型统一人类行为原语（`like` / `dislike` / `saved` / `comments`）**：全部会话消息反馈响应与历史消息回读对象新增 `saved: boolean` 字段（默认 `false`），与现有 `reaction`（`"like" | "dislike" | null`）和 `comments` 共享底层语义（与 `news` 领域对齐）。
  - **新增收藏与列表检索接口**：
    - `PUT /api/sessions/:sessionId/messages/:messageId/feedback/saved`（body：`{ piSessionId, saved }`）独立切换单条消息收藏状态，不改变点赞/点踩或评论，追加 `saved_changed` 原始审计事件。
    - `GET /api/sessions/:sessionId/messages/feedback?piSessionId=...&saved=...&reaction=...` 按当前 `piSessionId` 与可选 `saved` / `reaction` 条件返回有活跃行为记录的消息列表（`messageId`、`role`、`feedback: { reaction, saved, comments }`、`updatedAt`）。
  - **领域消费对齐（习惯热缓冲 `pendingSignals`）**：仅收藏未点赞/评论的通知消息也会作为反馈样本写入对应领域的习惯热缓冲（可通过 `GET /api/habits/sms` 的 `pendingSignals` 查看）。
  - **存储层迁移至 `main.sqlite`**：`sessions/<sessionId>/feedback/` 目录不再使用，反馈事件流与索引状态统一保存在 `main.sqlite` 的 `message_feedback_events` 与 `message_feedback_states` 表，对外 HTTP 契约保持兼容扩展。

### 2026-11-23 — 工作区指令与人设文件支持顶部 YAML Frontmatter `include:` 拆分引用

- **影响端形态**：`rich-ui`、`all`
- **类型**：`feature`
- **契约入口**：`/docs`「助手设置」「人设」「信息后台」「新闻」
- **要点与接入端注意**：
  - **支持顶部 `include:` 拆分指令**：全部 5 份工作区托管 Markdown（`workspace/assistant/{SOUL,USER,INSTRUCTIONS}.md` 与 `workspace/domains/{sms,news}/INSTRUCTIONS.md`）均支持在文件最顶部使用标准 YAML Frontmatter（`---\ninclude:\n  - ./sub.md\n---` 或单条 `include: ./sub.md`）引用相对于当前文件目录的工作区纯文本文件。
  - **原文读取/保存不变、注入前实时展开并附带诊断**：`GET`/`PUT` 接口及工作区文件编辑继续原样返回并保存含 frontmatter 的文本，绝不展平回写；服务端在组装模型提示词前实时展开（最多 5 层嵌套、自动环路/重复去重、上限 60,000 字符），并通过接口 `includes` 字段返回各引用路径状态（`loaded` / `missing` / `invalid` / `cycle` / `depth_exceeded` / `truncated` / `empty`）。
  - **缺失容错**：引用文件缺失、越出 `workspace/` 边界、遇到符号链接或非纯文本时静默跳过，不会报错或阻止保存与执行。

### 2026-11-23 — 领域偏好字段统一为 `instructions`，并移除 Dream 运行时提示词覆盖（Clean Break）

- **影响端形态**：`rich-ui`、`webhook`、`all`
- **类型**：`breaking`
- **契约入口**：`/docs`「信息后台」「新闻」「记忆」「工作区文件」（以 `/openapi.json` 为准）
- **要点与接入端注意**：
  - **偏好请求/响应字段统一更名为 `instructions`**：`GET / PUT /api/information/preferences` 与 `GET / PUT /api/news/preferences` 原字段 `notes` 统一更名为 `instructions`（与 `/api/assistant/instructions` 对齐）；短信日常实时筛选系统提示词收紧为「默认静默（Default-Silent）」基线 + 四级优先级。
  - **工作区领域文件统一命名为 `INSTRUCTIONS.md`**：`workspace/domains/sms/RULES.md` 与 `workspace/domains/news/RULES.md` 统一更名为 `workspace/domains/sms/INSTRUCTIONS.md` 与 `workspace/domains/news/INSTRUCTIONS.md`。
  - **Dream 移除运行时提示词字段**：所有静态系统提示词统一托管在服务端仓库 `prompts/`；`GET /api/dream` 不再返回 `globalPrompt` 与 `defaultPrompt`，`PUT /api/dream` 仅接受 `{ enabled: boolean }`（不再接收 `prompt`）。

### 2026-11-22 — 短信/信息后台 Clean Break 双通道重构（`/api/information/*` 破坏性调整）

- **影响端形态**：`webhook`、`rich-ui`
- **类型**：`breaking`
- **契约入口**：`/docs`「信息后台」（具体字段以 `/openapi.json` 为准）
- **要点与接入端注意**：
  - **移除旧首轮与混用开关**：`POST /api/information/items` 移除 `bulkImport`（单批恢复 1–100 条，固定进入日常 `queue: "realtime"`）；`POST /api/information/runs` 不再接收 `forceInitial` / `background`（现仅可选 `{ retryFailed?: boolean }` 用于日常实时单周期）；响应不再返回 `initialAnalysisCompleted` 或 `mode`。
  - **新增独立历史归档通道**：历史短信导入改调 `POST /api/information/archive/items`（1–500 条，`queue: "archive"`，与实时调度彻底隔离）；导入后显式调用 `POST /api/information/archive/run`（`{ background?, retryFailed? }`）逐批提炼增量习惯写入通用 `habits` 引擎，并在归档清零后至多发送 1 条不超过 1200 字简报。
  - **状态与列表字段更新**：`GET /api/information/status` 返回 `{ enabled, batchWindowSeconds, running, pendingCount, failedCount, archive: { running, pendingCount, processedCount, failedCount }, lastRunAt, lastError }`；条目新增 `queue`（`realtime | archive`），run 新增 `kind`（`realtime | archive`）且支持按 `queue` / `kind` 过滤分页。长期习惯列表与主对话消息反馈闭环继续对实时与归档双向生效。

### 2026-11-22 — 建立多形态接入端须知机制与当前协议关键注意点

- **影响端形态**：`all`
- **类型**：`caveat`
- **契约入口**：`/docs`「基础」「会话」「通知」「审批」「工作区文件」「信息后台」「任务」
- **要点与接入端注意**：
  - **双 SSE 帧格式完全不同（`all` 对话/状态端）**：`GET /api/events` 发送标准 `event: <name>` + `data: <JSON>` 以及每 30 秒 `: keep-alive` 注释心跳，断连不取消后台运行；`POST /api/conversation/run` **不发送 `event:` 行**，只发送 `data: <JSON>` 需按 `data.type` 分派，且断开 HTTP 连接会立即取消服务端本轮运行。
  - **受限/无屏端触及文件写入仍须人工审批（`embedded-voice`）**：服务端模型永不绕过写文件审批，也不会根据端形态放行；若语音/单片机端发起的对话触发了 `write`/`edit`，服务端会挂起等待人工决定（默认 5 分钟过期不落盘）。无屏端应明确提示用户前往富交互端审批，或等待超时/停止后告知未写入。
  - **无头投喂接口为全局路径（`webhook`）**：原始信息接入 `POST /api/information/items` 不带 `:sessionId`（当前实时上限、归档独立入口及 Clean Break 字段变更见上方 `2026-11-22` 条目）。
  - **轻量对话端最小闭环无需接 `/api/events`（`embedded-voice`）**：ESP32、智能音箱或 CLI 只做对话时，只需 `POST /api/session` + `GET /api/conversation`（读取 `revision`）+ `POST /api/conversation/run`（提取 `TEXT_MESSAGE_CONTENT` 文本增量）+ `POST /api/conversation/stop`；语音识别（ASR）与合成（TTS）留在接入端自行处理。
  - **每日定时任务时区由服务端解释（`all`）**：创建或修改 `daily: true` 任务时，`at` 传严格两位 `HH:mm`，服务端按 `GET /api/health` 返回的 `timeZone` 解释；`nextRunAt` 统一返回带 `Z` 的 UTC ISO 8601。
  - **工作区文本中的 SVG/HTML 绝不执行（`rich-ui`）**：`GET /api/workspace/files/content` 会把 SVG/HTML 归为 `kind: "text"` 原样返回，接入端必须按不可信纯文本渲染；手动新建/保存文本前须向用户完整展示内容后再传 `confirmed: true`。
