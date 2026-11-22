# Pi Muse 服务端接入须知与变更记录（Client Notes）

> **本文用途**：服务端在持续演进过程中，每当产生**需要外部接入端注意的事项**（如新增可接入能力、行为/状态码调整、破坏性变更、易踩坑边界或对受限/无屏端的影响），由服务端 Agent 顺手记在此处。**无外部影响的重构或内部修复不记入**，避免流水账。

## 给接入端 Agent（怎么读）

1. **先明确自身形态**：先阅读 [客户端接入与协作指南](client-integration-guide.md)，判断当前接入端属于 `webhook`（无头/投喂）、`embedded-voice`（ESP32/智能音箱/CLI 等轻量对话端）还是 `rich-ui`（手机/Web/桌面富交互端），只接入自身需要的能力集。
2. **按标签筛选下方条目**：结合条目的**影响端形态**（`all` / `rich-ui` / `embedded-voice` / `webhook`）与**类型**（`breaking` / `feature` / `behavior` / `caveat`）核对是否影响自己的接入逻辑。
3. **以运行时契约为准**：精确路径、请求/响应字段、校验边界与错误码一律以目标实例免鉴权的 `GET /docs`、`GET /openapi.json` 及 `GET /api/health`（特别是 `serviceVersion.sourceHash`）为唯一事实源。

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

### 2026-11-22 — 建立多形态接入端须知机制与当前协议关键注意点

- **影响端形态**：`all`
- **类型**：`caveat`
- **契约入口**：`/docs`「基础」「会话」「通知」「审批」「工作区文件」「信息后台」「任务」
- **要点与接入端注意**：
  - **双 SSE 帧格式完全不同（`all` 对话/状态端）**：`GET /api/events` 发送标准 `event: <name>` + `data: <JSON>` 以及每 30 秒 `: keep-alive` 注释心跳，断连不取消后台运行；`POST /api/conversation/run` **不发送 `event:` 行**，只发送 `data: <JSON>` 需按 `data.type` 分派，且断开 HTTP 连接会立即取消服务端本轮运行。
  - **受限/无屏端触及文件写入仍须人工审批（`embedded-voice`）**：服务端模型永不绕过写文件审批，也不会根据端形态放行；若语音/单片机端发起的对话触发了 `write`/`edit`，服务端会挂起等待人工决定（默认 5 分钟过期不落盘）。无屏端应明确提示用户前往富交互端审批，或等待超时/停止后告知未写入。
  - **无头投喂接口为全局路径（`webhook`）**：原始信息接入 `POST /api/information/items` 不带 `:sessionId`，单批上限 500 条；`(source, externalId)` 同内容幂等回读、不同内容返回 `409` 且不覆盖原文；历史批量分片导入建议传 `bulkImport: true`。
  - **轻量对话端最小闭环无需接 `/api/events`（`embedded-voice`）**：ESP32、智能音箱或 CLI 只做对话时，只需 `POST /api/session` + `GET /api/conversation`（读取 `revision`）+ `POST /api/conversation/run`（提取 `TEXT_MESSAGE_CONTENT` 文本增量）+ `POST /api/conversation/stop`；语音识别（ASR）与合成（TTS）留在接入端自行处理。
  - **每日定时任务时区由服务端解释（`all`）**：创建或修改 `daily: true` 任务时，`at` 传严格两位 `HH:mm`，服务端按 `GET /api/health` 返回的 `timeZone` 解释；`nextRunAt` 统一返回带 `Z` 的 UTC ISO 8601。
  - **工作区文本中的 SVG/HTML 绝不执行（`rich-ui`）**：`GET /api/workspace/files/content` 会把 SVG/HTML 归为 `kind: "text"` 原样返回，接入端必须按不可信纯文本渲染；手动新建/保存文本前须向用户完整展示内容后再传 `confirmed: true`。
