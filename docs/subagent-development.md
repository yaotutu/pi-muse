# Subagent 开发规范

本文是 Pi Muse 服务端新增与维护专职 **Subagent** 的唯一工程开发规范。所有新业务子代理（无论由后台触发、主聊天路由，还是双入口共用）必须遵守本规范，不再另造独立 Agent 执行器或临时从主会话拼装能力。

---

## 1. 核心架构与不可逾越的红线

Pi Muse 的非主聊天 AI 能力采用**「唯一底层执行内核 + 唯一上层静态注册中心」**两层结构：

- **底层内核**：[src/adapters/pi/subagent-runner.ts](../src/adapters/pi/subagent-runner.ts)（`runSubagent` 与结构化封装 `runStructuredSubagent`）
- **上层注册中心**：[src/features/subagents/registry.ts](../src/features/subagents/registry.ts) + [src/adapters/pi/subagents/catalog.ts](../src/adapters/pi/subagents/catalog.ts)

### 设计红线

1. **纯函数语义（无跨次聊天上下文）**
   - 任何 Subagent 对外都是无状态纯函数 `input -> output`，不持有跨次对话历史，不读取主聊天历史。
   - 单次执行周期内拥有独立的内存会话（`SessionManager.inMemory`），可多轮思考与调用工具，执行结束即释放。
2. **静态自包含（默认零继承主聊天能力）**
   - 每个 Subagent 必须在定义中显式绑定自己的提示词、工具、技能与 MCP（预留槽位），**绝不**从主聊天会话动态借用技能或工具。
   - 内核层硬禁 `bash` 与递归 `subagent`，任何 Subagent 均不得突破此底线。
3. **提示词语言统一规范**
   - 仓库内 `prompts/` 下所有系统提示词必须使用**英文**编写，并明确要求面向用户输出简体中文（除非用户规则指定其他语言）。
   - 不在主聊天提示词 [prompts/assistant/subagents.md](../prompts/assistant/subagents.md) 中硬编码点名具体 Subagent；每个开放聊天路由的 Subagent 必须通过自身的 `description` 与 `routingHint` 字段自我声明职责与路由避坑提示。
4. **写操作与人工审批边界**
   - 后台无头模式（`background`）只允许使用带严格 JSON Schema 校验的结构化提交工具，不得授予自由写文件工具。
   - 聊天路由模式（`chat`）如需修改该 Subagent 关联的工作区规则文件（`workspace/subagents/<id>/INSTRUCTIONS.md`），必须通过运行时上下文透传的 `writeWorkspaceFile` 走**版本绑定人工审批**，且写路径写死为本 Subagent 专属文件，不可越权改写 `SOUL.md`、`USER.md` 或 `assistant/INSTRUCTIONS.md`。
5. **输出通道由业务语义决定，进主窗口即对主模型可见**
   - 每个业务自行决定产出是留在独立列表视图（如新闻文章）还是推入主聊天窗口（如重要短信提醒、归档简报）。
   - 凡是推入主聊天窗口的通知消息（带 `subagentId` 标记），均直接对主模型可见（所见即所得），不再做隐藏过滤。
6. **独占资源显式声明**
   - 绑定独占共享资源（如实例唯一 Chrome）的 Subagent 必须声明 `executionPolicy: { stateless: true, parallelAllowed: false }`，框架会在 `parallel` 并发模式下直接拒绝调用。

---

## 2. Subagent 定义结构（`SubagentRegistration`）

定义在 [src/features/subagents/types.ts](../src/features/subagents/types.ts)：

| 字段 | 职责与要求 |
| --- | --- |
| `id` | 小写字母开头，匹配 `/^[a-z][a-z0-9_-]{0,63}$/`，同时作为路由目标、通知标记 `subagentId`、习惯库路径 `/api/habits/:subagentId` 与工作区目录 `workspace/subagents/<id>/` |
| `name` | 面向前端与用户展示的中文名称（如「短信助手」） |
| `description` | 一句话能力名片，同时暴露给主聊天 `subagent` 工具描述与 `GET /api/subagents` |
| `routingHint?` | 该 Subagent 自己维护的「给主聊天的路由注意事项」（英文），主聊天自动提取拼入系统提示词，并透出到 `GET /api/subagents` / `GET /api/subagents/:id` |
| `triggers` | 支持的触发入口：`["chat"]`、`["background"]` 或 `["chat", "background"]` |
| `isEnabled?` / `isChatAvailable?` | `isEnabled` 表达业务开关状态（前端可见）；若后台开关关闭但仍允许主聊天查库或改规则，由 `isChatAvailable`（默认 `true`）控制聊天可见性 |
| `executionPolicy` | `{ stateless: true, parallelAllowed: boolean }` |
| `prompts()` | 返回该 Subagent 绑定的全部内置提示词片段（含 `key`、`label`、`trigger`、`sourcePath`、`content`），供 `GET /api/subagents/:id` 完整展示 |
| `tools` / `skills` / `mcp` | 静态声明绑定的全部工具、技能与 MCP 服务器清单（当前无 MCP 时传 `[]`） |
| `userInstructions?` | 可选，关联 `workspace/subagents/<id>/INSTRUCTIONS.md` 与习惯快照 |
| `runChatTask?` | `triggers` 含 `"chat"` 时必填，内部调用 `runSubagent` 完成单次内存执行 |

---

## 3. 新增一个 Subagent 的标准 6 步清单

1. **编写系统提示词（全英文）**
   - 聊天路由态提示词放 `prompts/subagents/<id>-chat.md`（或 `prompts/subagents/<id>.md`）；
   - 后台结构化提示词放 `prompts/<id>/*.md`；
   - 同步登记到 [prompts/README.md](../prompts/README.md)。
2. **准备专属工具与数据边界**
   - 聊天态工具：只暴露本 Subagent 需要的最小只读查询与受控写工具（写工作区规则必须复用 `ctx.writeWorkspaceFile`）。
   - 后台态工具：通过 `runStructuredSubagent` 绑定唯一带严格 schema 校验的提交工具。
   - 如需持久化用户规则文件，在 [data-layout.ts](../src/adapters/storage/data-layout.ts) 与 [managed-text.ts](../src/adapters/workspace/managed-text.ts) 声明 `workspace/subagents/<id>/INSTRUCTIONS.md`；如需接入行为习惯归纳，在 `create-service.ts` 注册到 `habits`。
3. **在 `catalog.ts` 注册 `SubagentRegistration`**
   - 在 [src/adapters/pi/subagents/catalog.ts](../src/adapters/pi/subagents/catalog.ts) 中完整填写 `id`、`name`、`description`、`routingHint`、`triggers`、`executionPolicy`、`prompts`、`tools`、`skills`、`mcp`、`userInstructions` 与 `runChatTask`。
   - 注册后即**自动**进入：
     - 主聊天系统提示词与 `subagent` 工具路由（若含 `"chat"`）；
     - 前端只读检视接口 `GET /api/subagents` 与 `GET /api/subagents/:id`。
4. **事件与命名统一**
   - 数据变更推送 `/api/events` 时统一调用 `workspaceEvents.subagentChanged("<id>", scope)`（发出 `subagent_updated` 事件）。
   - 不再引入 `domain`、`domainId`、`domain_updated` 等旧命名。
5. **补齐自动化测试与真实验收**
   - 单测/集成：更新 [tests/integration/subagents.test.ts](../tests/integration/subagents.test.ts) 验证新 Subagent 在 `/api/subagents` 与 `/api/subagents/:id` 的契约输出，补齐路由、审批与错误边界测试。
   - 门禁与真实验收：执行 `pnpm check`，并在本地真实后端与外部真实模型上验证主聊天路由及结构化执行闭环，核对 `/openapi.json` 与 `/docs`。
6. **同步文档与客户端须知**
   - 更新 [docs/architecture.md](architecture.md)、成对中英文用户手册 [docs/manual/subagents.md](manual/subagents.md) / [docs/manual/en/subagents.md](manual/en/subagents.md) 并执行 `pnpm docs:build`。
   - 若影响外部接入端，在 [docs/client-notes.md](client-notes.md) 记录变更要点。
