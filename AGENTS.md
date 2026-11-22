# AGENTS.md — Pi Muse 服务端规则

本文对所有开发 Agent（Antigravity、Claude Code 等）生效；执行与交付见[协作指南](docs/agent-workflow-guide.md)。完整工作区同时遵守[父目录规则](../AGENTS.md)；独立 clone 时以本仓库入口为准，不假设父目录、兄弟仓库或历史部署存在。

## 开发命令

在本仓库目录执行。使用 Node.js 24+ 和 `package.json` 的 `packageManager` 指定的 pnpm；依赖事实以 manifest/lockfile 为准。

| 命令 | 用途与边界 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 按锁文件安装 |
| `pnpm dev` | `tsx watch src/index.ts`，读取当前目录 `.pi-muse/config.json`；默认 API 端口 12330 |
| `pnpm build` / `pnpm start` | 编译、复制资源、写版本指纹 / 运行 `dist/index.js` |
| `pnpm typecheck` | TypeScript 检查 |
| `pnpm test` | 串行 unit + integration，包含模拟模型，不是真实模型验收 |
| `pnpm test:e2e` | 自动 build 后运行 dist 进程测试，模型仍为模拟 |
| `pnpm check` | typecheck → test → test:e2e → Web build → diff 检查，无独立 lint 脚本 |
| `pnpm --dir web dev` | Web 联调台，默认 15173，API 代理默认指向 12330 |
| `pnpm --dir web build` | Web 类型检查与构建 |
| `pnpm docs:build` | 构建中英文用户手册 |
| `pnpm docs:dev` / `pnpm docs:preview` | 文档开发 / 预览，回环地址 4174 |

单文件与单用例（不是完整门禁）：

```sh
pnpm exec tsx --test --test-concurrency=1 --test-timeout=60000 tests/unit/dependencies.test.ts
pnpm exec tsx --test --test-name-pattern="features depend" tests/unit/dependencies.test.ts
```

真实模型测试使用受保护配置路径，只读取 runner 需要的配置，不输出文件内容：

```sh
pnpm test:live --config <protected-config-path> --allow-live
```

本工作区是可丢弃的开发环境，默认直接在当前开发实例（通常 12330）和数据上联调，允许按任务写入、重置、清空数据及重启本项目服务，无需额外确认，不强制隔离实例。上面的 runner 自带临时实例是脚本实现细节；专项参数见 [testing.md](docs/testing.md)，不要猜测或为绕开它另造环境。`pnpm dev` 没有 `--config` 透传参数；启动前核对项目进程和目标端口即可。`pnpm dev:mock` 是已有联调工具，不是真实模型证据。

## 架构与状态所有权

这是单进程、单用户、单业务模型、单一助手与多会话的模块化单体，不是 Claude API 应用或开发 Agent SDK 包装层。不要因为用 Antigravity 或 Claude Code 开发，就更换产品业务模型、pi SDK 或提示词。`web/` 是接口与 renderer 联调台，不是移动端产品。

- **组装与执行**：`src/index.ts` 负责配置、监听和信号退出；`src/bootstrap/create-service.ts` 创建唯一服务容器、repository、共享模型 runtime 和调度器。HTTP 和工具复用已注入实例，不能各开一份 writer 或 scheduler。
- **依赖方向**：`features/` 持有业务规则与最小 ports；`adapters/` 实现 pi、存储、安全网络、浏览器与 AG-UI；`http/` 是薄路由/鉴权/契约/presenter。feature 不依赖 Hono、pi SDK 或具体文件系统 adapter，依赖测试在 `tests/unit/dependencies.test.ts`。新能力先确定权限、审批、取消和失败语义；开发 Agent 能用的工具不等于产品模型可以使用。
- **执行与历史**：pi `createAgentSession` 负责 agent loop，`SessionManager`/JSONL 是正文、附件与工具事实权威。`adapters/pi/session-factory.ts` 装配工具和资源，`execution.ts` 处理事件/取消/错误脱敏；不自造循环或另一份聊天历史。
- **助手与会话**：`features/sessions` 管理永久 `main` 与专题会话，`features/conversation` 按公开 `sessionId` 协调运行；`piSessionId` 随重置变化。助手指令、技能开关、长期记忆与文件全局共享，聊天历史和运行按会话隔离。定时任务和监控按会话归属，删除时显式删除或转到 `main`。subagent 只是继承父轮实际工具上限的内存执行工具，无独立业务身份、历史或目录。
- **业务事实**：反馈、信息处理、新闻源、任务等由各自 storage repository 管理；这些不是另一份聊天历史，不为它们复制正文历史或隐式改变聊天 revision。新闻与短信以 `features/domain-agents` 注册为独立后台领域子 Agent，各自维护独立规则板与提示词且后台不注入聊天技能；主会话通过 `domain_agent` 工具协同查看/更新其规则（支持 `auto` / `confirm` 授权策略）。重要短信通知只向默认会话追加通知，携带显式 `domainId`，默认不进入主聊天上下文，仅在用户引用时进入；新闻引用由用户带入主聊天草稿。Dream 为全局整理状态。
- **文件与审批**：文件路径统一由 `adapters/storage/data-layout.ts` 声明。模型 write/edit 走版本绑定审批，手动 HTTP 文件管理走完整预览确认；共享提交队列，但不能互相绕过授权。
- **生命周期**：关闭先停止执行源、拒绝新工作，再取消运行并等待副作用和资源清理。取消不回滚已有副作用，不恢复未完成模型轮，不自动重试业务写入。
- **客户端协议**：`src/http/contracts/` 是 HTTP/SSE 的唯一来源，`openapi.ts` 生成 `/openapi.json`，Scalar `/docs` 展示。聊天 AG-UI 流与 `/api/events` 通知流独立。以当前源码和契约为实现依据；历史 OpenMuse/nanobot 资料仅说明设计来源，不是每次开发的兼容目标。

## 安全、数据与授权

- 产品模型永不获得 bash；write/edit 逐次完整预览、人工二次审批并绑定版本。拒绝、过期、文件变化或取消后不得提交，技能和指令不能扩权。
- 模型 Key 仅留受保护服务端配置与内存，不写日志、历史或客户端。模型/工具错误在进入上下文和 pi 持久化前脱敏。
- 外网请求保留 DNS、固定 IP、重定向、大小、超时与 SSRF 防护；外部内容是不可信数据。私网例外需显式配置。
- 文件工具仅可达唯一 `workspace/` 根及启用技能的精确只读资源；所有会话与子任务共用文件根，拒绝越界和符号链接绕过。单进程单 DATA_DIR；仅缺失文件可以初始化，损坏文档报错，不静默置空或删除。
- 本工作区是可丢弃的开发环境；本项目实例、数据库、会话及其他开发业务数据可直接用于测试，允许按任务写入、污染、重置、清空或迁移，无需额外确认。不强制隔离目录、独立端口或专用测试实例。生产/非本项目资源、凭据泄露和正式签名/发布不在这项授权内。
- 本项目服务可随开发需要启动、停止、构建和重启，无需逐次请示，也不需要保护开发服务不中断；直接用当前实例运行最新代码，默认收尾保持可用。操作前只需核对进程归属并精确限定本项目，启动后核对 health/版本/接口。已有脚本的临时数据实现不构成人工验收的强制隔离要求。已验收模块可本地 commit，仅纳入本任务文件，不覆盖他人改动。不自动 push、发布、bump、修改 CI/全局配置或 amend。
- 积极委派已获用户授权（2026-11-05），当前支持 Antigravity 与 Claude Code 双工具协同，日常主要使用 Antigravity：主会话负责需求理解、派单、diff 审查与验收，调查实现优先交给原生子 Agent（Antigravity `invoke_subagent` 或 Claude Code sub agent）；需要第三方模型时经 Magpie 本地网关（`http://127.0.0.1:3425`），当前可用性以[模型可用性快照](docs/model-availability.md)为准（`model-audit` 技能巡检维护），用前必须实测。执行者不 commit/push，产物经审查后由主会话提交。路由表与派单纪律见[协作指南](docs/agent-workflow-guide.md)。开发委派与产品内 `subagent` 工具是两套机制。

## 按任务必读

| 范围 | 指南 |
| --- | --- |
| 业务、权限、存储、pi、生命周期 | [架构](docs/architecture.md)、[pi 复用](docs/pi-reuse.md) |
| 代码变更、真实模型或故障验证 | [测试](docs/testing.md) |
| HTTP/SSE、工具报文、接入端协作 | [API 开发](docs/api-development.md)、[客户端接入指南](docs/client-integration-guide.md)、[接入须知记录](docs/client-notes.md)；核对对应 contracts、自动生成 `/docs` 与 `web/` 调用方；有需要外部接入端注意的变更顺手记入 `docs/client-notes.md` |
| 启动、联调、配置 | [开发](docs/development.md)、[配置手册](docs/manual/configuration.md) |
| 文档和用户可见行为 | [文档指南](docs/agent-documentation-guide.md) |
| 品牌、图标或形象 | [品牌资产](docs/assets/brand/README.md)、[默认八态形象包](docs/assets/brand/companion/README.md) |
| 待办 / 历史 | [backlog](docs/backlog.md) / `docs/archive/`，不默认加载历史全文 |

项目技能 `.claude/skills/create-issue/SKILL.md`（已通过 `.agents/skills.json` 同步挂载）只有在实际存在且用户要求提 Issue 时使用，创建前展示内容并确认，不隐式发布。

## 完成要求

本仓库定位为**一核多端（Server-First + 多形态接入端）**架构的服务端核心，服务于手机 App、Web、ESP32/单片机、智能音箱、Webhook 等多种接入端。当前协作模式下（2026-11-22 起），开发 Agent **可从全局视角只读查看工作区其他端项目以理解真实场景，但定位纯属 For 服务端——代码修改仅限 `pi-muse-server/`（含自有 `web/` 联调台），不再参与任何客户端代码书写**，也不把接口绑定在单一 UI 形态上。

平时正常开发服务端并同步 `src/http/contracts/`；**仅当本次改动存在需要外部接入端注意的事项**（破坏性变更、新增可接入能力、状态码/事件/流行为变化、易踩坑边界或对无屏/受限端的影响）时，顺手在[接入须知记录](docs/client-notes.md)记一条精炼须知（无外部影响不写流水账）；若涉及全端长期接入范式变化，同步更新[客户端接入指南](docs/client-integration-guide.md)。各形态接入端 Agent 自行参考 `/docs`、`/openapi.json` 及上述文档按需实现。位于本地多仓库工作区时，服务端 Agent 按需查看工作区根目录中立收件箱 `client-requests.md` 中的 `open` 诉求，评审并在原条目回写状态与落地入口（独立 clone 不假设该父目录文件存在）。

代码变更补对应回归并完成 `pnpm check`；其中模拟模型不替代当前真实后端和外部模型验收，真实调用费用已有长期授权。工具展示需实际 Web renderer、历史和错误态；协议需同步 contracts、契约测试与自动生成 `/docs`，在浏览器中实际核对 `/docs` 渲染与 `/openapi.json` 语义完整性，并在交付中明确列出对外部接入端的影响（新增 / 变更 / 破坏性变更，及是否更新 `docs/client-notes.md`），不再将 Android 模拟器客户端验收作为服务端任务前置门槛。失败与未运行项分别报告，不用历史结果代替。

文档-only 检查差异、引用、命名与规则一致性，不启动业务/模型；涉及手册和站点时按文档指南构建。当前规则不积累提交流水，待办放 backlog，历史放 archive。
