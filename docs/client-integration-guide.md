# Pi Muse 客户端接入与协作指南

> **协作定位（2026-11-22 起生效）**：Pi Muse 是**一核多端（Server-First + 多形态接入端）**架构。本工作区服务端侧虽然可以看到工作区内全部代码并保持全局视角，但**只负责服务端 `pi-muse-server/`（含自有 `web/` 联调台），其他部分一概不管**——不修改、不清理也不介入任何接入端或非服务端文件；若对其他项目有建议或发现旧/无用文件，只需通过工作区根目录异步收件箱 `client-requests.md` 留一条 `NOTE-*` 留言即可。外部接入端（手机 App、Web、ESP32/单片机、智能音箱、Webhook、自动化脚本等）通过本文、接入须知记录与运行实例自动生成的 `/docs` 自主接入，**无需 100% 照搬本文建议，按自身端形态各取所需即可**。

## 给接入端 Agent 的三步阅读入口

1. **先看本文第 1–2 节**：确定当前接入端属于 `webhook`、`embedded-voice` 还是 `rich-ui`，认清全端共通的 `Must` 硬边界与各自可选的 `Should` / `May`。
2. **再看 [服务端接入须知与变更记录](client-notes.md)**：按自己的端形态标签快速扫一遍服务端近期留下的注意点、行为变化与易踩坑边界。
3. **最后核对运行时唯一权威**：访问目标服务端免鉴权的 `GET /api/health`、`GET /docs` 与 `GET /openapi.json`，获取当前实例的精确路径、字段校验、错误码与事件 schema。

> **需要服务端新增接口或修改契约时**：若位于统一多仓库工作区，直接在工作区根目录中立收件箱 `client-requests.md` 追加一条 `REQ-*`（独立环境输出同格式文本交由用户转发）；不要直接修改 `pi-muse-server/` 或自行绕过协议。

---

## 1. 多形态接入端分级模型（按需接入）

不同硬件与平台的能力差异很大，服务端刻意不将能力绑定到单一 UI 形态。各接入端只需按自身形态选择对应层级接入：

| 端形态标签 | 典型形态 | 推荐最小接入集合 | 关键取舍与边界 |
| --- | --- | --- | --- |
| **`webhook`** | 无头服务、传感器上报、Webhook 转发、自动化脚本 | `GET /api/health` + `POST /api/session` + 目标写入/查询 REST（如 `POST /api/information/items`） | **不需要**连接 `GET /api/events` 或聊天 SSE；聚焦 Token 安全存储、幂等键设计与“写入超时先查不重发”。 |
| **`embedded-voice`** | ESP32 等单片机、智能音箱、穿戴设备、CLI / IM 机器人 | `GET /api/health` + `POST /api/session` + `GET /api/conversation`（取 `revision`）+ `POST /api/conversation/run` + `POST /api/conversation/stop` | ASR/TTS 或设备事件转文字留在接入端侧；流式只提取 `TEXT_MESSAGE_CONTENT` 与终态即可，**不强求**接 `/api/events` 或本地缓存全量历史。若无屏端对话意外触发了模型文件写入，服务端仍挂起等人工审批（默认 24 小时过期不落盘），端侧不可绕过，应提示用户转往富交互端确认或告知未落盘。 |
| **`rich-ui`** | 原生手机 App（RN / Flutter）、Web 工作台、桌面客户端 | 完整双流（连接级 1 条 `GET /api/events` + 会话级 `POST /api/conversation/run`）+ 会话管理 + 模型审批 + 按需扩展领域 | 建议实现多会话保活、完整前后文文件审批预览、手动工作区文件确认、后台领域引用及各类业务管理页。 |

---

## 2. 协作边界：Must / Should / May 三层模型

| 层级 | 含义 | 适用范围与具体内容 |
| --- | --- | --- |
| **Must（硬边界 / 协议不变量）** | 违反会导致鉴权失败、数据错乱、状态覆盖或破坏安全隔离 | 1. **凭据安全（全端）**：只持久化服务地址与 Bearer Session Token；**严禁**持久化明文 `accessKey`，**严禁**将 Bearer Token 放入任何 URL query（图片、SSE、WS 均不可）。<br>2. **契约唯一权威（全端）**：精确路径、请求/响应字段、校验边界与错误码以运行实例 `GET /docs`、`GET /openapi.json` 及 `src/http/contracts/` 为准，不猜测、不另建手写规范。<br>3. **写入未明不重发（全端）**：除明确声明幂等的操作外，写入超时/断网必须先回读服务端权威状态，禁止静默自动重发。<br>4. **聊天提交不变量（对话端）**：`POST /api/conversation/run` 不回传全量历史，必须提交 `expectedRevision` 并正确处理 `409` 版本/删除冲突。<br>5. **身份与版本合并（涉及对应实体时）**：严格区分 `sessionId`、`piSessionId` 与 `instanceId`；运行状态仅在同 `instanceId` 内按 `(sessionId, runId, revision)` 合并，审批按 `(id, revision)` 跨实例合并。<br>6. **文件审批与手动确认（富交互 / 文件端）**：模型文件审批必须向用户完整展示不可变 `before`/`after` 原文并由人决定；区分 `status: "approved"`（人的授权）与 `execution.status`（真实落盘结果）。手动文件写/建仅在向用户完整展示并确认后才传 `confirmed: true`，不得以此绕过模型审批。<br>7. **不可信内容隔离（全端）**：外部网页、RSS、短信、文本附件以及工作区 `kind: "text"` 中的 SVG/HTML 一律按不可信纯文本处理，禁止直接当 HTML/脚本执行。 |
| **Should（推荐工作模式）** | 服务端围绕这些模式设计；采用后体验与状态一致性最佳 | 1. **连接级单通知流（`rich-ui`）**：每个服务器连接只维持一条 `GET /api/events` SSE 长连接，由连接级分发至各模块。<br>2. **按 `ready` 整集重建（`rich-ui`）**：每次收到 `ready` 首帧，整体替换本地进行中运行、待审批与在线状态集合，不做断线前后并集。<br>3. **聊天流与界面解耦（`rich-ui` / 多会话端）**：切换会话或界面时保持在途聊天流挂载、独立保留每会话草稿；若轻量端不保活后台流，切出前提醒用户或显式调用 Stop。<br>4. **失效信号防竞态（订阅 `/api/events` 时）**：收到 `conversation_updated` 后标脏并重读 `GET /api/conversation`；正在流式输出时可延后至流结束后再刷，刷新请求进行中又收新事件须补刷。<br>5. **领域通知结构化引用（`rich-ui`）**：对后台领域（如 `sms`）通知卡片，采用 `【领域引用:<domainId>】...【引用结束】` 格式追加到草稿由用户发送。<br>6. **渐进接入（全端）**：先跑通对应端形态的最小闭环，再按需逐步扩展。 |
| **May（接入端完全自主空间）** | 完全由各端自行决策，服务端不做任何约束 | 1. 硬件形态、操作系统、语言、固件或跨端框架（RN、Flutter、Web、C/Rust/Python、脚本等）。<br>2. 信息架构、交互方式（触屏 UI、语音播报、命令行、纯后台无界面）。<br>3. 视觉主题、配色、动效、音频反馈与助手形象是否展示/如何展示。<br>4. 端侧状态管理方案、内存缓冲策略与本地草稿存储方式。<br>5. 纯端侧展示偏好（置顶分组、折叠、字号、播报语速等）。<br>6. 是否接入次级领域（目标、Dream、浏览器控制、形象包等）以及接入顺序。 |

---

## 3. 协议事实源与双边 Agent 异步协作机制

### 3.1 唯一协议入口

- **可读文档**：`GET /docs`（免鉴权，Scalar 交互式文档；优先加载服务端同源 `/scalar.js`，离线失败时回退 CDN）。
- **机器可读契约**：`GET /openapi.json`（免鉴权，OpenAPI 3.1，由服务端 `src/http/contracts/` 通过 zod v4 schema 自动生成）。其中：
  - SSE 端点的每一种事件 schema 与行为说明在对应端点的 `responses["200"]["x-sse-events"]` 与 `description`；
  - WebSocket 协议（如真实浏览器帧流、动态视口与交互输入）在顶层 `x-websocket-contracts`；
  - 每个端点均含 `description` 与 `x-agent-hint`，包含调用前置条件、副作用、冲突码与同步步骤。

### 3.2 实例版本与时区核对

接入、调试或遇到异常时，先请求免鉴权的 `GET /api/health`：

- `configured`：服务端业务模型是否已配置（决定 `POST /api/conversation/run` 能否运行，未配置返回 `503`）。
- `timeZone`：服务端所在本地时区 IANA 标识（如 `Asia/Shanghai`）。每日定时任务 `daily: true` 的 `at`（`HH:mm`）按此时区解释，接入端无需代算 UTC。
- `serviceVersion`：`{ version, commit, dirty, sourceHash, mode, builtAt }`（与 `/openapi.json` 顶层 `x-service-version` 一致）。
  - **关键约定**：当 `dirty === true` 或 `commit === null` 时，绝对不要仅凭 `commit` 判断运行代码是否最新，必须比对 `sourceHash`（SHA-256 源码指纹）。

### 3.3 无凭据本地联调

服务端提供内置模拟联调入口（不依赖真实大模型 Key 与外网费用）：

- 在 `pi-muse-server/` 执行 `pnpm dev:mock`：固定监听 `127.0.0.1:17891`，数据隔离在 `.pi-muse/mock/`，支持预设触发词（如时间、读文件、写入审批、`slow`、`fail-once` 等，详见 `docs/testing.md` 的 fake-model 触发词章节）。
- 注意：Mock 联调仅用于验证协议解析与交互流程，真实验收仍须对接真实后端与真实外部模型。此外，同仓库 `web/` 仅用于服务端接口与 renderer 联调，不代表所有外部接入端的形态标准。

### 3.4 服务端与接入端 Agent 的异步协作方式

- **平时正常演进 + 顺手留痕（仅管服务端）**：服务端 Agent 虽能只读查看全部代码，但**只负责服务端本身**——专注写服务端代码、补回归测试，并同步维护 `src/http/contracts/` 使 `/docs` 与 `/openapi.json` 自解释，其他项目与非服务端文件一概不管。**只有当改动存在需要外部接入端留心的事项时**（破坏性变更、新可接入能力、行为边界调整或受限端易踩坑点），才顺手在 [服务端接入须知与变更记录](client-notes.md) 记下一条结构化须知；若涉及全端长期接入范式变化，则同步更新本指南。
- **各端按需自读与独立落地**：无论后续开发手机 App、Web、ESP32 固件、音箱接入还是 Webhook 脚本的 Agent，只需在开工或升级前对照本指南、[client-notes.md](client-notes.md) 与运行实例的 `/docs`、`/openapi.json`，自行决定接入范围与实现方式。
- **双向异步收件箱（工作区根目录 `client-requests.md`）**：
  - **接入端 → 服务端（`REQ-*`）**：若某类接入端因自身形态需要新的接口、字段、精简投影或修正契约问题，向工作区根目录中立收件箱 `client-requests.md` 追加 `REQ-YYYYMMDD-NN`（独立仓库或远端接入端可按同模板输出 `REQ-*` 文本交由用户转贴），写清场景与痛点而不直接修改 `pi-muse-server/`。诉求状态按 `open` → `need-clarification` / `accepted` / `done` / `declined` 流转；服务端 Agent 基于架构与安全边界（绝不放宽无 bash、文件版本审批、禁止 URL 传 Token 等底线）评审后在原条目回写结论、落地 `/docs` 入口或安全替代方案，具普适性的外部影响同步记入[client-notes.md](client-notes.md)。**不要**通过高频轮询、解析助手自然语言回复或端侧私自绕过安全边界的方式处理缺失契约。
  - **服务端 → 其他项目（`NOTE-*`）**：若服务端 Agent 在全局只读视角下对其他项目有建议，或发现某个其他项目存在旧/无用文件，只需在 `client-requests.md` 给对应项目留一条 `NOTE-YYYYMMDD-NN` 留言并止步于此，不越界改动对方代码；目标项目 Agent 或用户查看后自主决定采纳、清理或忽略。

---

## 4. 系统心智模型与状态所有权

Pi Muse 是**单进程、单用户、单一助手身份、多会话上下文、唯一扁平工作区**的个人助手核心：

- 只有一个助手身份，**没有**多智能体切换、群组路由或按接入端/会话隔离的私有工作区目录。
- 专题会话（`sessionId` 为 UUID）只隔离**聊天历史、草稿、运行状态与步骤记录、以及定时任务/监控/审批的来源归属**；助手设定、技能、记忆、文件工作区、短信、新闻与浏览器是实例全局共享的。多形态接入端既可以共用 `main` 主会话，也可以各自创建或绑定独立的专题 `sessionId`（语音/传感器内容由端侧转为文本或结构化请求提交）。

### 4.1 状态所有权对照表

| 归属层 | 数据与状态 | 接入端职责 |
| --- | --- | --- |
| **服务端实例全局** | 模型配置、`SOUL.md` / `USER.md` / `INSTRUCTIONS.md`、技能资产与开关、长期记忆、长期目标、Dream 状态与待决项、短信原始条/批处理、新闻源/文章/偏好、唯一 `workspace/` 文件、真实 Chrome 实例、自定义助手形象包 | 按需读取与调用对应写入 REST；**不保存**模型 Key，**不维护**第二份业务事实权威副本 |
| **服务端公开会话级** | 会话元数据（标题/时间）、pi JSONL 聊天正文/附件/工具历史、运行步骤时间线、消息反馈（点赞/评论）、定时任务/监控/审批的归属 `sessionId` | 按 `sessionId` 读取权威历史与归属视图；不可擅自改写历史消息 |
| **服务端单次运行级** | 运行互斥锁、取消信号、内存运行状态投影（`session_status_updated`）、当轮临时审批授权 | 按 `(sessionId, runId)` 展示状态或提交 `stop` / `decision` |
| **接入端本地自有** | 服务器 Base URL、Bearer Session Token、端侧设备配置、未发送草稿与待发附件、本地 UI/硬件偏好（主题/音量/播报/缓存） | 按服务器连接（`baseUrl` 维度）隔离存储；换服时彻底销毁连接级缓存 |

### 4.2 三个核心身份 ID（不可混用）

| ID | 含义与来源 | 生命周期与用途 |
| --- | --- | --- |
| `sessionId` | 公开会话标识：固定 `"main"` 或服务端生成的规范小写 UUID | `reset` 后保持**不变**；用于聊天接口、历史查询、会话重命名/删除与任务归属 |
| `piSessionId` | 当前绑定在会话上的 pi 历史树标识（服务端生成） | `reset` 后会**更换为新值**（空或不存在的合法会话返回 `null`）；用于消息反馈校验（防评价到已重置旧历史）与过滤迟到的 `conversation_updated` 帧 |
| `instanceId` | 产生 SSE/运行状态的服务进程 UUID | 服务端每次重启会**变化**。**注意区别**：运行状态（`session_status_updated` / `/api/runs/status`）的 `revision` 仅在单进程内存有效，`instanceId` 变化后必须清空运行版本缓存；而审批（`approval_*`）的 `revision` 跨进程持久化，**不能**因 `instanceId` 变化而重置或清空 |

### 4.3 鉴权、请求上限与错误恢复

1. **鉴权获取与传递**：
   - 调用 `POST /api/session`（Body：`{ accessKey?: string }`，服务端未配置访问密钥的回环开发部署可省略或传空对象）换取 `{ token, mode: "live" }`。
   - 该 Bearer Token 长期有效（除非服务端配置修改或清除了 `accessKey`），后续所有 `/api/*` 请求通过请求头 `Authorization: Bearer <token>` 传递（`/api/health`、`/api/session`、`/docs`、`/openapi.json`、`/scalar.js`、`/updates/android/*` 与一次性 ticket 落地入口除外）。
   - **安全红线**：接入端只持久化服务地址与 `token`，**绝不持久化明文 `accessKey`**，也不在日志/错误上报中打印 `token` 或 `accessKey`。
   - **禁止 URL 传 Token**：浏览器原生 `EventSource` 不支持自定义请求头，**不要**为图方便把 token 放进 URL query；请使用支持自定义 Header 的流式 HTTP 客户端读取 SSE；下载助手形象 PNG 等二进制资源同样必须走带 `Authorization` 头的请求。需要从浏览器/WebView 打开响应式真实浏览器操控页 `/browser` 或连接 `/ws/browser` 时，先用 Bearer Token 调用接口换取 10 分钟有效的一次性 ticket。
2. **常见 HTTP 状态码约定**：
   - `401 Unauthorized`：Token 失效或未授权；提示并引导重新鉴权，**禁止**用无效凭据无限自动重连（尤其是 SSE）。
   - `409 Conflict`：版本冲突（聊天 `expectedRevision`）、会话正忙/正删除（`SESSION_DELETING`）、审批已进入其他终态（409 Body 会附带最新 `{ error, approval }` 完整视图）、删除会话清单过期（`SESSION_SCHEDULES_CHANGED`）或任务仍在运行（`SESSION_JOB_RUNNING`）。处理原则：**保留未成功提交的本地草稿/待发载荷**，先刷新权威状态，再决定下一步。
   - `413 Request Too Large`：通用 JSON 请求体上限为 **1 MiB**；例外：`POST /api/conversation/run` 与 `POST /api/browser/uploads/:uploadId` 上限为 **12 MiB**，`PUT /api/companions/:packId/assets/:state` 上限为 **2 MiB**。受限内存设备或富端应在发送前按对应限额预检。
   - `503 Service Unavailable`：服务端正在优雅关闭、业务模型未配置或浏览器功能未启用；如实反馈不可用并适当退避。
3. **写入未明禁止自动重发，GET 失败禁止伪装为空**：
   - 当任何写请求（发送消息、文件保存、审批决定、删除/创建资源）遇到网络断开或超时导致结果未明时，**严禁**后台静默重试，必须保留现场并先调用对应 `GET` 接口核对服务端真实状态。
   - 仅下列接口具备服务端显式幂等语义（且有严格条件）：
     - `POST /api/conversation/run`：仅当使用**完全相同**的 `runId`、`message.id`、`content` 与相同的附件顺序及字节 SHA-256 重试同一已完成轮时，服务端会通过 `MESSAGES_SNAPSHOT` 事件幂等重放。
     - `POST /api/approvals/:id/decision`：对同一审批重复提交相同的 `approve`/`deny` 决定，幂等返回 200 原审批且不再次执行、不推进 `revision`。
     - `POST /api/information/items`：同一 `(source, externalId)` 与相同内容重复接入会幂等回读，但若内容不同会返回 `409` 且不覆盖原文。
   - 任何 `GET` 请求失败时保留端侧已有有效快照并提示错误，**不要**把网络失败伪装成“空列表”。
4. **换服与迟到响应隔离**：
   - 切换服务器地址或退出当前服务器连接时，销毁该连接下所有内存状态、SSE 连接与缓存。
   - 所有异步请求回包应绑定发出时的连接代次与 `(sessionId, piSessionId)`，若已切服、切会话或已重置历史，丢弃迟到响应。

---

## 5. 双流协作架构（核心运行模式）

服务端刻意把**全工作区状态同步**与**单轮聊天文本流**拆分为两条完全独立的 SSE 通道。接入端按自身形态按需订阅：

| 维度 | 全局实时状态与失效流 `GET /api/events` | 单会话聊天流 `POST /api/conversation/run` |
| --- | --- | --- |
| **适用端形态** | 主要面向 `rich-ui`；`webhook` 与轻量 `embedded-voice` 通常不需要建立 | 所有对话端（`embedded-voice`、`rich-ui`） |
| **作用域与数量** | 连接级（整个服务器连接 **只建 1 条**，服务端单实例总并发上限 8 条，超限 429） | 会话/运行级（每会话同一时刻 1 个运行，不同会话可并行） |
| **SSE 帧格式（⚠️ 重要差异）** | 标准多字段帧：**同时发送 `event: <事件名>` 和单行 `data: <JSON>`**，末尾 `\n\n`；按 `event:` 名称分派 | 仅数据帧：**不发送 `event:` 行**，只发送 `data: <JSON>\n\n`；按解析后 JSON 的 `data.type` 分派 |
| **心跳机制** | 每 **30 秒**发送注释帧 `: keep-alive\n\n`（非 JSON，不能送入 JSON.parse） | 无独立注释心跳（流式生成期间持续推块） |
| **断连语义** | **不影响任何服务端运行**（聊天、定时任务、子代理、审批等待全部继续） | **不影响服务端运行**（断开只解除当前流订阅，模型、工具、子代理与审批全部在后台继续完成并落盘；只有显式 `POST /api/conversation/stop`、超时、会话重置/删除或服务关闭才取消） |
| **重放与重连同步** | 不发送 `id:`、忽略 `Last-Event-ID`；重连靠新首帧 `ready` 整集重建 + 主动回读目录与打开的会话历史 | 若运行仍在进行，可用 `GET /api/conversation/stream?sessionId=...&runId=...` 重挂（先补发已累积文本快照，再推实时增量）；运行已结束或已断线则从 `GET /api/conversation` 读取权威历史与 `lastRun` |

### 5.1 全局通知流 `GET /api/events` 消费规范（`rich-ui` 及状态订阅端）

1. **连接建立与异常处理**：
   - 使用支持流式读取和自定义 Header（`Authorization: Bearer <token>`）的 HTTP 客户端逐 chunk 读取，按 UTF-8 解码并按空行（`\n\n`）切分帧；过滤以 `:` 开头的注释心跳行（`: keep-alive`）。
   - 握手阶段返回 `401` 停止重连并走重新鉴权；`429`（`TOO_MANY_CONNECTIONS`）清理多余连接后退避重试；`503` 退避重试。
2. **首帧 `ready` 完整替换原则**：
   - 每条连接恰好发送一次 `ready` 作为首帧（`ready` 最大 12 MiB，单个增量事件最大 8 MiB；队列或单帧超限时服务端主动断流以促使接入端重连全量对齐）。
   - `ready` 包含：`instanceId`、`serverTime`、`sessionPresences`、`sessionStatuses`、`pendingApprovals`。
   - **必须整体替换**当前进行中的运行集合、待审批集合和头像在线状态集合，绝不与断线前本地缓存合并。未出现在 `sessionPresences` 中的会话视为空闲；当通知流处于断开状态时，会话状态为**未知**，不要渲染成空闲。
   - **重连后补读**：收到 `ready` 后，主动重读一次 `GET /api/sessions` 和当前已打开会话的 `GET /api/conversation`，恢复断线窗口内新建/改名/删会话及已落盘的通知/任务回复。
3. **版本合并与字段注意**：
   - **运行状态与步骤（`session_status_updated`）**：按 `(sessionId, runId)` 合并，**只应用严格大于本地已知 `revision` 的帧**，相等或更小直接丢弃；若帧内 `instanceId` 与本地记录不同，说明服务端已重启，**先清空运行状态与运行 `revision` 缓存**再以新 `ready`/新帧重建。每次运行自动在 `steps` 数组中累加工具/子代理/审批/文件提交步骤；运行终态（`succeeded`/`failed`/`cancelled`，`phase: null`，`endedAt` 非空）会推送一次，且包含实际动作、定时任务或异常中断的运行会随会话持久化并汇总动作摘要。`GET /api/runs?sessionId=...` 只返回这些有效执行记录（普通纯文字问答不记入），单次运行终态与断线恢复通过 `GET /api/runs/status?sessionId=...&runId=...` 查询。
   - **待审批与终态（`approval_pending` / `approval_updated`）**：按 `id` 索引并按严格更高 `revision` 合并。审批 `revision` 跨进程持久，**不能**因 `instanceId` 变化清空。`approval_pending` 直接包含完整不可变 `preview`，收到即可展示并供用户决定；`approval_updated` 省略了 `title`、`kind`、`preview` 以避免重复推大正文，若本地没有完整预览或收到未知 `id`，按需回读 `GET /api/approvals/:id`。
   - **会话在线态（`session_presence_updated`）**：同一连接按到达顺序覆盖，优先级规则由服务端维护（等待用户 > 错误 > 工作中）；`lastActiveAt` 仅用于会话活跃排序，不用于版本比较。不要使用 `serverTime`/`updatedAt` 排序或用事件数量计数业务操作。
4. **失效信号与防竞态刷新**：
   - `session_directory_updated`：重读 `GET /api/sessions`。
   - `domain_updated`：携带 `{ instanceId, domain, scope }`（`scope` 为 `items | runs | habits | preferences | settings`）；按对应领域（如 `"sms"`）与 `scope` 定向刷新偏好、习惯或列表状态，替代高频轮询。
   - `browser_updated`：携带 `{ instanceId, scope, handoff? }`（`scope` 为 `tabs | viewport | files | handoff | lifecycle`）；当真实浏览器切换标签、调整视口、上传/下载变化或助手发起/解除人工接管（`handoff`）时推送，客户端按需刷新或提示用户接管。
   - `conversation_updated`：仅携带 `{ instanceId, sessionId, piSessionId }`，不含消息正文。收到后核对 `instanceId`：
     - 对当前展示中的会话：若该会话此刻正在跑聊天 SSE 流，先打“历史待刷新”脏标记，等本轮流收尾后再读 `GET /api/conversation`；否则立即读取。**如果一次 `GET /api/conversation` 请求尚未返回期间又到达新的 `conversation_updated`，必须在这次请求完成后立刻补读一轮**，避免漏掉新消息。
     - 对后台未激活会话：可仅保留脏标记，待切回该会话时再读取权威历史，节省请求。
     - 当返回的 `piSessionId` 与本地视图旧值不同（说明远端发生了 reset），丢弃旧消息缓存与旧反馈状态并替换为新历史。

### 5.2 单会话聊天流 `POST /api/conversation/run` 消费规范（`embedded-voice` / `rich-ui`）

1. **请求结构**：
   - 提交 `{ sessionId, runId, expectedRevision, message: { id, content, attachments? } }`。不回传历史消息；新空会话的 `expectedRevision` 为 `"empty"`。
   - **轻量端（`embedded-voice`）获取 `expectedRevision`**：内存紧张无需缓存全量 `messages` 时，可在每轮对话前调用 `GET /api/conversation?sessionId=...` 读取当前最新 `revision` 再提交；若返回 `409` 则重读 `revision` 后由用户或端侧策略决定是否重试（不要无脑覆盖未确认变更）。
   - `attachments` 最多 4 项，随该消息一次性提交（无独立文件上传接口）：支持 `image/png`、`image/jpeg`、`image/gif`、`image/webp` 与严格 UTF-8 文本（PDF/Office/压缩包等其他二进制拒绝；SVG/HTML 作为文本处理；具体单图及总字节限制以 `/docs` 契约为准，整条请求体上限 12 MiB）。
2. **事件顺序与流式渲染 / 轻量消费**：
   - 正常序列：`RUN_STARTED` → 多组交替的 `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT*` / `TEXT_MESSAGE_END` 与 `TOOL_CALL_START` / `TOOL_CALL_ARGS*` / `TOOL_CALL_END` / `TOOL_CALL_RESULT` → 终态二选一（`RUN_FINISHED` 或 `RUN_ERROR`）。同成功 `runId` 幂等重放路径会发出 `MESSAGES_SNAPSHOT`。
   - **富交互端**：`TOOL_CALL_START.toolCallName` 用于工具卡片匹配渲染；受控/隐藏策略下的工具可能不发送增量参数甚至整组工具事件，且 `TOOL_CALL_RESULT.content` 已由服务端脱敏/摘要，直接按契约渲染即可。
   - **语音 / 嵌入式端**：流式读取只关注 `TEXT_MESSAGE_CONTENT.delta`（可按句分段送入端侧 TTS 降低首字延迟）、`RUN_FINISHED` 和 `RUN_ERROR` 即可；忽略工具增量细节即可安全工作。
   - **重要**：本流只包含主助手执行输出，子代理（`subagent`）和底层模型思维过程不会把内部原始流嵌套进来。
3. **停止（Stop）与收尾**：
   - 需要主动中断生成（如用户在音箱打断播报或界面点击停止）时，调用 `POST /api/conversation/stop` 并同时携带 `{ sessionId, runId }`（精确绑定本轮，迟到请求不会误伤下一轮），等待 `stop` 与当前流收尾；富交互端回读一次 `GET /api/conversation` 对齐服务端实际持久化结果。
   - 断开 HTTP 连接**不会**取消服务端运行（服务端会在后台继续执行直到完成）；客户端回到前台或重连后，若运行仍在执行可调用 `GET /api/conversation/stream?sessionId=...&runId=...` 重挂实时流，若已结束直接读取 `GET /api/conversation`（含 `lastRun`）。
4. **多会话保活建议（`rich-ui`）**：
   - 推荐保持已打开会话的聊天流与未发送草稿按 `sessionId` 驻留，切换会话或切页面只切换可见性而不卸载底层 SSE 读取；切后台或进程被杀后，回到前台可自动根据 `/api/events` 与 `GET /api/conversation` 的 `lastRun` 接回 `GET /api/conversation/stream` 或刷新权威历史。

---

## 6. 按领域接入参考（按端形态选读）

接入端可随时从核心能力起步，按自身设备形态增量扩展以下领域：

### 6.1 会话生命周期（`/api/sessions*`，适合 `embedded-voice` / `rich-ui`）

- `main` 会话首次启动即存在，标题固定为“默认会话”，排在列表第一位，**不可删除，可重置**；其余专题会话按 `updatedAt` 倒序排列，由服务端生成 UUID。
- **重置（`POST /api/sessions/:sessionId/reset`）**：取消在途运行与待审批、清空 pi JSONL 与消息反馈，保留公开 `sessionId`、标题、定时任务/监控和全局助手设置，但 `piSessionId` 会换新；不可恢复，操作前应由用户明确确认。
- **两步删除专题会话**：
  1. 先调用 `GET /api/sessions/:sessionId/schedules` 获取该会话名下全部定时任务/监控清单及 `scheduleRevision`。
  2. 让用户明确选择 `scheduleDisposition`（`"delete"` 一并删除，或 `"move-to-main"` 保留并迁移到 `main`），再携 `scheduleRevision` 调用 `DELETE /api/sessions/:sessionId`。
  3. 若返回 `409 SESSION_SCHEDULES_CHANGED`（预览期间清单变化）或 `409 SESSION_JOB_RUNNING`（选择保留但原会话任务仍在跑），刷新清单或等待运行结束后再确认。

### 6.2 运行状态、步骤时间线与受控工具展示（`/api/runs*` & `session_status_updated`，适合 `rich-ui`）

- `session_status_updated` 中的 `phase` 为 `preparing` / `waiting_model` / `responding` / `executing_tool` / `waiting_subagents` / `waiting_approval` / `finalizing`（终态为 `null`）；`steps[]` 实时累积并在结束后持久化到会话历史，通过 `GET /api/runs?sessionId=...` 分页读取。
- `tools[]` 中每项含 `{ toolCallId, name, label, status, subagentId }`。**受控或隐藏工具的 `name`/`toolName` 会显式输出 `null`**，此时界面应展示服务端提供的 `label`/`title`/`detail`，切勿把 `null` 判定为报错或缺失字段。

### 6.3 模型文件审批与手动工作区文件（强安全契约，适合 `rich-ui`，`embedded-voice` 需知边界）

这两条链路共享服务端写提交队列，但**权限语义绝不能混用或互绕**：

1. **模型文件审批（`/api/approvals*` + `/api/events`）**：
   - 待审批项由 `ready.pendingApprovals` 和 `approval_pending` 推送完整视图（含 `title`、`kind`: `file_write` | `file_edit` | `proposal` | `action`、`expiresAt` 与不可变 `preview`，支持 `type: "file_diff"` 文件对比与 `type: "proposal"` 通用建议/操作要点）。
   - **展示要求（`rich-ui`）**：必须把 `preview.before` 与 `preview.after` 全文完整展示给用户核对（不得截断、不得只显示片段摘要、也不得用读取当前磁盘文件来替代历史登记时的 `preview`）。`scope` 为 `"workspace"` 或 `"skill"`（实例技能文本）。
   - **无屏/语音端边界（`embedded-voice`）**：无完整文本核对与明确人机交互确认条件的设备，**不要**擅自替用户调用审批决定接口；若对话触发文件写入导致挂起等待，提示用户前往富交互端处理（默认 24 小时过期后安全放弃，不会落盘）。
   - **提交决定**：只能由用户显式操作后调用 `POST /api/approvals/:id/decision`（Body 仅 `{ decision: "approve" | "deny" }`）。如遇 `409`，用响应携带的 `approval` 更新本地视图。
   - **区分授权与落盘**：`status === "approved"` 仅代表“人已同意执行这一次绑定版本的预览操作”，**绝不代表文件已写入成功**！是否真正落盘必须观察 `execution` 字段（通过 `approval_updated` 或 `GET /api/approvals/:id` 获取）：
     - `execution === null`：尚未观察到执行；
     - `execution.status`: `"running"`（提交中）、`"succeeded"`（写入成功）、`"failed"`（失败，如文件版本已被外部修改或过期）、`"cancelled"`（运行被取消）、`"unknown"`（如写入中途进程中断，结果未知）。
     - 若出现 `"unknown"`，应如实提示用户先查看工作区文件核对结果，不要自动重发。
   - 审批历史分页使用 `GET /api/approvals`（只含终态摘要，无 `preview` 正文，需要看全文时查 `GET /api/approvals/:id`）。
2. **手动工作区文件管理（`/api/workspace/files*`）**：
   - 所有会话共用唯一扁平工作区（`workspace/`），接口不接受会话/根选择器，`path` 全部相对该根（根目录列表传 `.`）。
   - 读取详情 `GET /api/workspace/files/content` 会区分 `kind: "text" | "image" | "binary"`（`image`/`binary` 返回 `dataBase64`）。**安全要求**：SVG 与 HTML 文件服务端会按 `kind: "text"` 原样返回，接入端必须按不可信纯文本渲染或预览代码，**禁止当成可执行网页/脚本渲染**。
   - 新建（`POST /api/workspace/files/text`）或更新（`PUT /api/workspace/files/text`）文本时，服务端要求 Body 必填 `confirmed: true`。接入端必须在界面向用户完整展示待写入内容（更新时展示 `before`/`after` 对比）并得到用户明确保存确认后才提交，不得默认静默填充 `confirmed: true`。最后一次成功保存生效，写入只允许安全 ASCII 相对路径字符集（详情见 `/docs`）。

### 6.4 后台领域 Agent（`sms` 及后续扩展领域）

服务端采用「**单一主助手 + 多个独立后台领域 Agent**」架构：

- **指令文件与隔离原则**：每个领域 Agent 拥有独立系统提示词（仓库托管 `prompts/`）、独立用户显式指令 `instructions`（保存即覆盖，与工作区 `workspace/domains/<id>/INSTRUCTIONS.md` 同步，并返回顶部 `include:` 引用诊断 `includes`），以及由通用习惯引擎定期从反馈中提炼的长期习惯 `habits` 与未消化计数 `unconsolidatedFeedbackCount`（可通过 `GET /api/habits` 发现全部已注册领域，通过 `/api/habits/:domain` 查看完整习惯与 `pendingSignals` 待归纳明细、手动增删改及手动触发归纳，不覆盖明确 `instructions`）。后台领域 Agent **不读取**主聊天技能、`workspace/assistant/INSTRUCTIONS.md` 或全局 `memory`。在主聊天中，用户提到领域过滤/偏好时，主助手会调用 `domain_agent` 工具（`get_instructions` / `update_instructions`）协同查询或提议更新对应领域指令（更新仍走模型文件审批）。
- **主聊天通知隔离与结构化引用约定（推荐 `rich-ui`）**：
  - 后台重要通知会由服务端写入 `main` 会话历史，该消息带有可靠元数据：`metadata.source === "notification"`、`metadata.notificationId` 以及 `metadata.domainId`（如 `"sms"`）。
  - 服务端在每次送入主模型上下文前，**默认过滤掉所有带 `domainId` 的通知卡片**，避免零碎通知污染主对话。
  - 当用户在富交互端选中某条领域通知卡片“引用并提问”时，推荐按统一结构化格式将该内容作为不可信引用**追加到当前会话草稿**（不要自动替用户发送，由用户补充意图后再发送）：
    ```text
    【领域引用:<domainId>】
    ...（引用标题/时间/摘要或正文片段）...
    【引用结束】
    ```
  - 发送后，主助手即可在当轮上下文看到这段引用，并能准确将后续规则改动通过 `subagent` 工具路由到对应领域。
- **信息/短信与 Subagent 统一接入（`/api/subagents/*`、`/api/information/*`，适合 `webhook` / 投喂端 / `rich-ui`）**：
  - 全部专职 Subagent 统一通过 `GET /api/subagents`、`GET /api/subagents/:id`、`PATCH /api/subagents/:id`（`{ enabled }` 同时控制主聊天路由与后台调度）和 `GET/PUT /api/subagents/:id/mcp`（按 Subagent 独立勾选 MCP）检视与管理。
  - 短信端点均为全局路径（不带 `:sessionId`）；`sms` Subagent 的启用状态由 `PATCH /api/subagents/sms` 与 `/api/information/settings`（含 `batchWindowSeconds` 0–3600）双向同步；用户指令与 `include:` 诊断、已归纳习惯及未消化计数由对称契约 `/api/information/preferences`（`{ instructions, includes, habits, unconsolidatedFeedbackCount }`）返回，长期习惯、待归纳样本 `pendingSignals` 查看与手动归纳统一走 `/api/habits` 与 `/api/habits/sms`。
  - **日常实时接入**：调用 `POST /api/information/items`（1–100 条，进入 `queue: "realtime"`），以 `(source, externalId)` 为幂等键（同内容幂等回读，不同内容 `409 CONFLICT` 不覆盖原文；若 `sms` 尚未开启则自动开启，不再返回 `409 DISABLED`）；可通过 `POST /api/information/runs`（传 `{}` 或 `{ retryFailed?: boolean }`）立即触发一次单周期判定（可选重试失败条目）并推送通知到 `main`；`GET /api/information/items` 与 `GET /api/information/items/:itemId` 对已评估条目直接返回可选 `decision` 与 `reason`。
  - **历史批量归档**：与实时调度完全隔离——导入调用 `POST /api/information/archive/items`（1–500 条，进入 `queue: "archive"`，同样在 `sms` 未开启时自动开启），完成后显式调用 `POST /api/information/archive/run`（`{ background?, retryFailed? }`）逐批向通用习惯库增量沉淀习惯并在清空后（只剩内容审核确定性拒绝时可视为已清空）发至多 1 条 <= 1200 字简报；多条目批次被上游内容安全审核拒绝会自动二分隔离，仅真正触发审核的条目失败、其余正常处理，此时响应可能 `status: "partial"` 且 `briefingPublished: true`；进度通过 `GET /api/information/status` 的 `archive.{running, pendingCount, processedCount, failedCount}` 轮询。
### 6.5 其他可选领域与通用规则

- **定时任务与网页监控（`/api/jobs*`、`/api/monitors*`，`rich-ui` / `webhook`）**：
  - 绑定创建时的 `originSessionId`（省略默认 `main`），支持暂停/恢复/取消/重试/修改。
  - **时区规范**：当 `daily === true` 时，`at` 必须为严格 24 小时制两位 `HH:mm`（如 `"09:00"`），服务端按 `GET /api/health.timeZone` 解释，客户端在同地区使用可直接填本地时刻无需自行换算；当 `daily === false` 时，`at` 需为带时区偏移的 ISO 8601 时间戳（如 `"2026-10-22T09:00:00+08:00"`）。`nextRunAt` 统一返回带 `Z` 的 UTC ISO 8601。
- **消息反馈（`/api/sessions/:sessionId/messages/:messageId/feedback*` 与 `/api/sessions/:sessionId/messages/feedback`，`rich-ui`）**：
  - 仅 `metadata.feedbackAvailable === true` 的 `user` 或 `assistant` 消息（含历史推送通知）可设置互斥 `like`/`dislike`、独立收藏 `saved` 或多条评论，并支持按 `saved` / `reaction` 条件检索列表（`tool` 消息与正在生成中的流式占位消息不可反馈）。
  - 请求必须带上当前 `piSessionId`；若会话已重置，服务端返回 `409`。
- **长期目标、记忆与 Dream（`/api/goals*`、`/api/memories*`、`/api/dream*`，`rich-ui` / `webhook`）**：
  - 均为实例全局管理。激活态目标（`active`）会摘要注入每轮对话；长期记忆上限 500 条（满额返回 `409`）按需被模型检索；Dream 每两小时整理一次对话并产出待决建议（`pending`），调用 `POST /api/dream/pending/:pendingId` 应用（`apply`）或丢弃（`dismiss`）时即使建议来自已删专题会话，也只写入全局目标，绝不借此重建已删会话。
- **游标分页通用规范（全端适用）**：
  - 适用于执行记录（`/api/runs`）、审批历史（`/api/approvals`）、信息条目/run（`/api/information/items|runs`）和模型追踪（`/api/traces`）。
  - `cursor` / `nextCursor` 是绑定了当次过滤条件的不透明字符串，翻页时原样回传即可；**只要切换了任何过滤参数，必须清空旧 `cursor` 从第一页重新拉取**，否则会返回 `400`。此类分页不冻结快照，新增项出现在第一页。
- **助手形象包（`/api/companions*`，`rich-ui`）**：
  - 纯客户端展示资源，不进入模型上下文。每个完整包固定包含 8 个状态 PNG，顺序与名称为：`idle`、`thinking`、`responding`、`working`、`waiting-approval`、`success`、`error`、`stopped`。
  - 拉取包列表 `GET /api/companions` 后按 `version` 校验缓存，通过 `GET /api/companions/:packId/assets/:state`（带 Bearer Token 头，不可放 URL）下载 PNG 并核对 `ETag`。若服务端包被删除/损坏或切换服务器，接入端安全回退到内置形象；切换形象时不要重建整个连接宿主或断开 SSE。
- **共享真实浏览器（`/api/browser/*`、`/browser`、`/browser/launch`、`/ws/browser`，`rich-ui`）**：
  - 用户与产品助手共享同一个服务端懒启动的可见 Chrome，关闭客户端浏览窗口不会关闭后端 Chrome；同时兼容 HTTP 局域网与 HTTPS 反向代理。
  - 先查 `GET /api/browser/status` 确认 `enabled`、`running`、`viewerPath`、`viewport` 与当前人工接管 `handoff`（查询不会触发懒启动）。
  - **推荐嵌入式响应式操控页（`/browser`）**：用 Bearer Token 调用 `POST /api/browser/viewer-ticket` 获取 10 分钟有效的一次性 `launchPath`（`/browser/launch?ticket=...`），在受控 WebView 或浏览器同源打开后，服务端签发 `HttpOnly; SameSite=Strict` 会话 Cookie（仅授权 `/api/browser/*` 且不含 `viewer-ticket`）并 `303` 重定向至 `/browser`，内置手机/桌面视口切换、触控滚屏、双指缩放、原生中文输入条、实时文件/接管提示。
  - **原生自绘帧流方式**：调用 `POST /api/browser/ws-ticket` 换取 10 分钟有效的一次性 ticket，连接 `ws(s)://<host>/ws/browser?ticket=<ticket>`；也可通过 `PUT /api/browser/viewport` 或 WS `viewport` 消息切换视口，并用 `DELETE /api/browser/handoff` 确认完成人工接管。服务端二进制帧格式为 `uint32be metadataLength + UTF-8 JSON metadata + JPEG bytes`，客户端绘制后须发送 `{ type: "frame_ack", frameId, sessionId }` 配合流控。交互输入与实时 `tabs`/`viewport`/`files`/`handoff` 推送协议见 OpenAPI `x-websocket-contracts.browser`。
  - **上传与下载**：页面触发的待处理 `filechooser` 和持久化下载通过 `GET /api/browser/files` 或 WS `files` 获取，分别由用户明确选文件后调用 `POST /api/browser/uploads/:uploadId` 或 `GET /api/browser/downloads/:downloadId/content` 处理。
- **Android 更新镜像（`/updates/android/*`）**：
  - 免业务鉴权，仅原生 Android 客户端检查与下载 APK 更新时按需接入。

---

## 7. 接入端联调与上线自查清单

在接入或发版前，按当前设备/平台形态核对对应检查项：

### 全端通用（`all`）

- [ ] **版本核对**：已读取 `GET /api/health`，确认服务端 `configured`、`timeZone` 与 `serviceVersion.sourceHash` 匹配当前联调目标，并以该实例的 `/docs`、`/openapi.json` 为字段准绳。
- [ ] **已读须知**：已检查 [服务端接入须知与变更记录](client-notes.md) 中匹配本端形态的最新条目。
- [ ] **凭据与隔离**：本地仅保存服务器地址与 Session Token，无明文 `accessKey` 落盘；URL query 中无长期 Bearer Token；切换服务器时已彻底销毁连接状态与缓存。
- [ ] **写入未明与分页**：任何写入超时或中断未盲目重发，而是先回读核对服务端事实；翻页接口切换筛选条件时已清空 `cursor`。

### 对话端适用（`embedded-voice` / `rich-ui`）

- [ ] **聊天流解析**：使用 `POST /api/conversation/run` 时已按 `data.type`（而非 `event:`）分派，正确处理 `409` 并保留未提交输入；主动打断时调用 `POST /api/conversation/stop` 并同时传 `sessionId` + `runId`。
- [ ] **受限端审批降级（`embedded-voice`）**：无屏/语音端未试图替用户批准文件写入；当轮遇审批等待时能如实告知用户前往富交互端确认或提示未落盘。

### 富交互与安全写入端适用（`rich-ui`）

- [ ] **双流解耦**：每个连接只建 1 条 `GET /api/events`（按 `event:` 分派、过滤 `: keep-alive`、重连后用 `ready` 整集覆盖并重读目录和打开的会话）；切会话不断流或切出前显式确认/停止。
- [ ] **审批安全闭环**：模型审批完整展示了 `before`/`after` 原文且仅由人工触发决定；界面清晰区分“已批准（`approved`）”与“实际写入状态（`execution.status`）”；手动工作区写文本前明确展示并取得用户确认后才传 `confirmed: true`。
- [ ] **不可信内容防护**：工作区中的 SVG/HTML、外部新闻摘要、短信正文及网页标题均按纯文本/沙箱隔离呈现，未直接作为可信脚本/HTML 注入执行；异步回包已按连接代次及 `(sessionId, piSessionId)` 过滤迟到响应。
