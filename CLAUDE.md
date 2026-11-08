# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md
@docs/agent-workflow-guide.md

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

runner 建立隔离实例；专项场景与不同 runner 的参数见 [testing.md](docs/testing.md)，不要猜测共享参数。`pnpm dev` 没有 `--config` 透传参数；不要误启动或覆盖真实实例。`pnpm dev:mock` 是已有联调工具，不是真实模型证据；其固定数据目录不可当临时测试目录。

## 架构与状态所有权

这是单进程、单用户、单业务模型、单一助手与多会话的模块化单体，不是 Claude API 应用或 Claude Agent SDK 包装层。不要因为用 Claude Code 开发，就更换产品业务模型、SDK 或提示词。

- **组装与执行**：`src/index.ts` 负责配置、监听和信号退出；`src/bootstrap/create-service.ts` 创建唯一服务容器、repository、共享模型 runtime 和调度器。HTTP 和工具复用已注入实例，不能各开一份 writer 或 scheduler。
- **依赖方向**：`features/` 持有业务规则与最小 ports；`adapters/` 实现 pi、存储、安全网络、浏览器与 AG-UI；`http/` 是薄路由/鉴权/契约/presenter。feature 不依赖 Hono、pi SDK 或具体文件系统 adapter，依赖测试在 `tests/unit/dependencies.test.ts`。
- **执行与历史**：pi `createAgentSession` 负责 agent loop，`SessionManager`/JSONL 是正文、附件与工具事实权威。`adapters/pi/session-factory.ts` 装配工具和资源，`execution.ts` 处理事件/取消/错误脱敏；不自造循环或另一份聊天历史。
- **助手与会话**：`features/sessions` 管理永久 `main` 与专题会话，`features/conversation` 按公开 `sessionId` 协调运行；`piSessionId` 随重置变化。每会话指令与历史分开，文件使用唯一 `workspace/`。subagent 只是继承父轮实际工具上限的内存执行工具，无独立业务身份、历史或目录。
- **业务事实**：反馈、信息处理、新闻源、任务等由各自 storage repository 管理；这些不是另一份聊天历史。新闻与短信是全局后台管线，重要短信只向默认会话追加通知，不额外启动主聊天模型轮；新闻引用由用户带入选定会话。Dream 为全局整理状态。
- **文件与审批**：文件路径统一由 `adapters/storage/data-layout.ts` 声明。模型 write/edit 走版本绑定审批，手动 HTTP 文件管理走完整预览确认；共享提交队列，但不能互相绕过授权。
- **生命周期**：关闭先停止执行源、拒绝新工作，再取消运行并等待副作用和资源清理。取消不回滚已有副作用，不恢复未完成模型轮，不自动重试业务写入。
- **客户端协议**：`src/http/contracts/` 是 HTTP/SSE 的唯一来源，`openapi.ts` 生成 `/openapi.json`，Scalar `/docs` 展示。聊天 AG-UI 流与 `/api/events` 通知流独立；`web/` 只作联调，不是移动产品。

## 按任务读取

| 任务 | 指南 |
| --- | --- |
| 业务、存储、生命周期、权限 | [架构](docs/architecture.md)、[pi 复用](docs/pi-reuse.md) |
| 代码变更、真实模型或故障验证 | [测试](docs/testing.md) |
| HTTP/SSE、工具报文、多端适配 | [API 开发](docs/api-development.md)；核对对应 contracts 和实际 Web/mobile 调用方 |
| 启动、联调、配置 | [开发](docs/development.md)、[配置手册](docs/manual/configuration.md) |
| 文档和用户可见行为 | [文档指南](docs/agent-documentation-guide.md) |
| 图标或形象 | [品牌资产](docs/assets/brand/README.md)、[虚拟形象](docs/avatar.md) |
| 待办 / 历史 | [backlog](docs/backlog.md) / `docs/archive/`，不默认加载历史全文 |

在完整工作区还要读取父目录 `AGENTS.md`；独立 clone 时以本仓库入口为准，不假设本机路径、兄弟仓库或历史部署存在。项目技能 `.claude/skills/create-issue/SKILL.md` 只有在实际存在且用户要求提 Issue 时使用，创建前展示内容并确认，不隐式发布。
