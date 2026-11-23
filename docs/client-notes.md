# Pi Muse 服务端接入须知与变更记录（Client Notes）

> **本文用途**：服务端在持续演进过程中，每当产生**需要外部接入端注意的事项**（如新增可接入能力、行为/状态码调整、破坏性变更、易踩坑边界或对受限/无屏端的影响），由服务端 Agent 顺手记在此处。**无外部影响的重构或内部修复不记入**，避免流水账。

## 给接入端 Agent（怎么读）

1. **先明确自身形态**：先阅读 [客户端接入与协作指南](client-integration-guide.md)，判断当前接入端属于 `webhook`（无头/投喂）、`embedded-voice`（ESP32/智能音箱/CLI 等轻量对话端）还是 `rich-ui`（手机/Web/桌面富交互端），只接入自身需要的能力集。
2. **按标签筛选下方条目**：结合条目的**影响端形态**（`all` / `rich-ui` / `embedded-voice` / `webhook`）与**类型**（`breaking` / `feature` / `behavior` / `caveat`）核对是否影响自己的接入逻辑。
3. **以运行时契约为准**：精确路径、请求/响应字段、校验边界与错误码一律以目标实例免鉴权的 `GET /docs`、`GET /openapi.json` 及 `GET /api/health`（特别是 `serviceVersion.sourceHash`）为唯一事实源。
4. **反向提需求 / 反馈契约问题**：需要服务端新增接口、调整字段或上报协议问题时，统一向工作区根目录中立文件 `client-requests.md` 按 `REQ-YYYYMMDD-NN` 模板追加诉求（不直接修改 `pi-muse-server/` 文件；独立环境可输出同格式文本交由用户转贴）。

## 给服务端 Agent（怎么记）

- **何时记录**：仅当本次服务端改动涉及以下情况时追加记录——
  - `breaking`：端点下线、字段/事件名/状态码/语义变化或破坏性校验收紧；
  - `feature`：新增可供外部接入端调用的能力或新端形态入口；
  - `behavior`：默认行为、分页/排序、超时/过期、时区或幂等条件调整；
  - `caveat`：多形态接入端（尤其嵌入式/语音/无头端）极易踩坑的协议细节或交互边界。
- **不要记录**：纯内部重构、未改变对外协议的 bug 修复、测试与文档排版调整。
- **不要抄写 Schema**：写清楚“变了什么、哪类端受影响、接入端要注意什么、去 `/docs` 哪里查精确定义”，禁止手抄 JSON Schema 或字段清单。
- **倒序维护与定期清理**：新条目插在下方列表最顶部；已被后续变更覆盖，或已完全沉淀进 `/docs` 与 [client-integration-guide.md](client-integration-guide.md) 的长期稳定条目，可适时清理归并，保持文档精炼。

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

### 2026-11-23 — 消息反馈新增 `saved` 收藏原语与条件列表接口，底层迁移至 `main.sqlite`

- **影响端形态**：`rich-ui`、`all`
- **类型**：`feature`
- **契约入口**：`/docs`「消息反馈」（以 `/openapi.json` 为准）
- **要点与接入端注意**：
  - **全消息类型统一人类行为原语（`like` / `dislike` / `saved` / `comments`）**：全部会话消息反馈响应与历史消息回读对象新增 `saved: boolean` 字段（默认 `false`），与现有 `reaction`（`"like" | "dislike" | null`）和 `comments` 共享底层语义（与 `news` 领域对齐）。
  - **新增收藏与列表检索接口**：
    - `PUT /api/sessions/:sessionId/messages/:messageId/feedback/saved`（body：`{ piSessionId, saved }`）独立切换单条消息收藏状态，不改变点赞/点踩或评论，追加 `saved_changed` 原始审计事件。
    - `GET /api/sessions/:sessionId/messages/feedback?piSessionId=...&saved=...&reaction=...` 按当前 `piSessionId` 与可选 `saved` / `reaction` 条件返回有活跃行为记录的消息列表（`messageId`、`role`、`feedback: { reaction, saved, comments }`、`updatedAt`）。
  - **领域消费对齐（信息后台 `feedbackExamples`）**：`GET /api/information/preferences` 返回的示例新增 `saved: boolean`；仅收藏未点赞/评论的通知消息也会作为反馈样本进入 `feedbackExamples`。
  - **存储层迁移至 `main.sqlite`**：`sessions/<sessionId>/feedback/` 目录不再使用，反馈事件流与索引状态统一保存在 `main.sqlite` 的 `message_feedback_events` 与 `message_feedback_states` 表，对外 HTTP 契约保持兼容扩展。

### 2026-11-23 — 工作区指令与人设文件支持顶部 YAML Frontmatter `include:` 拆分引用

- **影响端形态**：`rich-ui`、`all`
- **类型**：`feature`
- **契约入口**：`/docs`「助手设置」「人设」「信息后台」「新闻」
- **要点与接入端注意**：
  - **支持顶部 `include:` 拆分指令**：全部 5 份工作区托管 Markdown（`workspace/assistant/{SOUL,USER,INSTRUCTIONS}.md` 与 `workspace/domains/{sms,news}/INSTRUCTIONS.md`）均支持在文件最顶部使用标准 YAML Frontmatter（`---\ninclude:\n  - ./sub.md\n---` 或单条 `include: ./sub.md`）引用相对于当前文件目录的工作区纯文本文件。
  - **原文读取/保存不变、注入前实时展开**：`GET`/`PUT` 接口及工作区文件编辑继续原样返回并保存含 frontmatter 的文本，绝不展平回写；服务端在组装模型提示词前实时展开（最多 5 层嵌套、自动环路/重复去重、上限 60,000 字符）。
  - **缺失容错**：引用文件缺失、越出 `workspace/` 边界、遇到符号链接或非纯文本时静默跳过，不会报错或阻止保存与执行。

### 2026-11-23 — 领域偏好字段统一为 `instructions`，并移除 Dream 运行时提示词覆盖（Clean Break）

- **影响端形态**：`rich-ui`、`webhook`、`all`
- **类型**：`breaking`
- **契约入口**：`/docs`「信息后台」「新闻」「记忆」「工作区文件」（以 `/openapi.json` 为准）
- **要点与接入端注意**：
  - **偏好请求/响应字段统一更名为 `instructions`**：`GET / PUT /api/information/preferences` 与 `GET / PUT /api/news/preferences` 原字段 `notes` 统一更名为 `instructions`（与 `/api/assistant/instructions` 对齐，自学习画像仍统一为 `learnedNotes`）；短信日常实时筛选系统提示词收紧为「默认静默（Default-Silent）」基线 + 四级优先级。
  - **工作区领域文件统一命名为 `INSTRUCTIONS.md`**：`workspace/domains/sms/RULES.md` 与 `workspace/domains/news/RULES.md` 统一更名为 `workspace/domains/sms/INSTRUCTIONS.md` 与 `workspace/domains/news/INSTRUCTIONS.md`。
  - **Dream 移除运行时提示词字段**：所有静态系统提示词统一托管在服务端仓库 `prompts/`；`GET /api/dream` 不再返回 `globalPrompt` 与 `defaultPrompt`，`PUT /api/dream` 仅接受 `{ enabled: boolean }`（不再接收 `prompt`）。

### 2026-11-22 — 短信/信息后台 Clean Break 双通道重构（`/api/information/*` 破坏性调整）

- **影响端形态**：`webhook`、`rich-ui`
- **类型**：`breaking`
- **契约入口**：`/docs`「信息后台」（具体字段以 `/openapi.json` 为准）
- **要点与接入端注意**：
  - **移除旧首轮与混用开关**：`POST /api/information/items` 移除 `bulkImport`（单批恢复 1–100 条，固定进入日常 `queue: "realtime"`）；`POST /api/information/runs` 不再接收 `forceInitial` / `background` / `retryFailed`，仅用于立即触发一次日常实时单周期；响应不再返回 `initialAnalysisCompleted` 或 `mode`。
  - **新增独立历史归档通道**：历史短信导入改调 `POST /api/information/archive/items`（1–500 条，`queue: "archive"`，与实时调度彻底隔离）；导入后显式调用 `POST /api/information/archive/run`（`{ background?, retryFailed? }`）逐批提炼更新 `learnedNotes` 灵敏度画像，并在归档清零后至多发送 1 条不超过 1200 字简报。
  - **状态与列表字段更新**：`GET /api/information/status` 返回 `{ enabled, batchWindowSeconds, running, pendingCount, failedCount, archive: { running, pendingCount, processedCount, failedCount }, lastRunAt, lastError }`；条目新增 `queue`（`realtime | archive`），run 新增 `kind`（`realtime | archive`）且支持按 `queue` / `kind` 过滤分页。`learnedNotes` 自学习画像与主对话消息反馈闭环继续对实时与归档双向生效。

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
