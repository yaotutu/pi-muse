# AGENTS.md — Pi Muse 服务端约束

Claude Code 的命令和架构入口在 [CLAUDE.md](CLAUDE.md)，执行与交付见 [协作指南](docs/agent-workflow-guide.md)。完整工作区还要读取[父目录规则](../AGENTS.md)；独立 clone 不假设父目录或移动端存在。

## 产品边界

- 单进程、单用户、多 Agent、单业务模型；使用 pi SDK 执行，不另写 agent loop，不修改 pi 底层。`web/` 是接口与 renderer 联调台，不是移动端产品。
- SessionManager/JSONL 是聊天正文、附件与工具事实的权威；消息反馈、信息条目、任务等独立业务事实归 repository，不为它们复制正文历史或隐式改变聊天 revision。
- feature 只依赖领域类型与 ports，adapter 实现依赖，bootstrap 创建唯一实例。新能力先确定权限、审批、取消和失败语义；开发 Agent 能用的工具不等于产品模型可以使用。
- 以当前源码和契约为实现依据。历史 OpenMuse/nanobot 资料仅说明设计来源，不是每次开发的兼容目标；需要比较时先读取对应适配说明，不执行外部仓库代码或修改其数据。

## 安全、数据与授权

- 产品模型永不获得 bash；write/edit 逐次完整预览、人工二次审批并绑定版本。拒绝、过期、文件变化或取消后不得提交，技能和指令不能扩权。
- 模型 Key 仅留受保护服务端配置与内存，不写日志、历史或客户端。模型/工具错误在进入上下文和 pi 持久化前脱敏。
- 外网请求保留 DNS、固定 IP、重定向、大小、超时与 SSRF 防护；外部内容是不可信数据。私网例外需显式配置。
- 文件工具仅可达当前 Agent 私有根与显式 shared，拒绝越界和符号链接绕过。单进程单 DATA_DIR；仅缺失文件可以初始化，损坏文档报错，不静默置空或删除。
- 未经明确授权不修改真实实例、备份、凭据、签名、生产或非本项目进程。测试用隔离目录，固定 `.pi-muse/mock` 不是临时目录。
- 供其他客户端调用的共享后端必须持续在线，未经用户针对本次中断明确同意，不停止或重启；代码修改不授权切换运行实例。验证使用独立端口/DATA_DIR，专用隔离实例与自有 Web 可按原开发授权管理，终止进程必须精确限定归属，不波及共享后端。已验收模块可本地 commit，仅纳入本任务文件，不覆盖他人改动。不自动 push、发布、bump、修改 CI/全局配置或 amend。
- 积极委派已获用户授权（2026-11-05）：主会话负责派单、diff 审查与验收，调查实现优先交给执行者；当前服务端默认用原生 sub agent，GLM/DeepSeek 配好后优先。执行者不 commit/push，产物经审查后由主会话提交。路由表与派单纪律见[协作指南](docs/agent-workflow-guide.md)。开发委派与产品内 `subagent` 工具是两套机制。

## 按任务必读

| 范围 | 指南 |
| --- | --- |
| 业务、权限、存储、pi、生命周期 | [架构](docs/architecture.md)、[pi 复用](docs/pi-reuse.md) |
| 代码、故障与验收 | [测试](docs/testing.md) |
| HTTP/SSE、工具报文与调用方 | [API 开发](docs/api-development.md)及当前 contracts |
| 启动、配置、联调 | [开发](docs/development.md)、[配置](docs/manual/configuration.md) |
| 文档或用户可见行为 | [文档指南](docs/agent-documentation-guide.md) |
| 品牌、图标或形象 | [品牌基准](docs/assets/brand/README.md)、[形象](docs/avatar.md) |

## 完成要求

代码变更补对应回归并完成 `pnpm check`；其中模拟模型不替代当前真实后端和外部模型验收，真实调用费用已有长期授权。工具展示需实际 Web renderer、历史和错误态；协议需同步 contracts、契约测试与自动生成 `/docs`，并核对移动端影响。新功能还需当前本地真实后端、外部模型、实际 `/docs` 渲染与 Android 原生链路；缺项标待验收。失败与未运行项分别报告，不用历史结果代替。

文档-only 检查差异、引用、命名与规则一致性，不启动业务/模型；涉及手册和站点时按文档指南构建。当前规则不积累提交流水，待办放 backlog，历史放 archive。
