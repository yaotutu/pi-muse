# 核心能力

本页只保留能力入口，具体操作放在对应指南中，避免同一流程重复维护。

## 对话与会话 {#conversations-and-agents}

移动端一级入口为「消息 / 新闻 / 设置」，消息直接打开永久 main 主聊天，不提供会话选择器。服务端保留历史与运行相互隔离的专题会话底座，助手指令与技能开关则全局共享，移动端目前只开放 `main`；全部会话共用一个扁平工作区。主聊天支持流式回复、停止与重置，见[对话与会话](conversations-and-agents.md)，指令配置与拆分方式见[指令与提示词](instructions.md)。当前源码能力不代表已安装 APK 已更新，请核对对应 Release。

## 附件、文件与审批 {#files-and-approvals}

消息附件随聊天历史进入模型上下文；工作区文件是服务端持久文件；模型发起的 `write` 和 `edit` 必须逐项人工审批。三者的入口、限制和危险操作见[附件、文件与审批](files-and-approvals.md)。

## 任务、目标与记忆 {#tasks-goals-and-memory}

- [新闻阅读](news.md)：RSS 源管理、推荐与全部时间线、逐篇反馈和收藏。
- [任务与网页监控](tasks-and-monitors.md)：通过聊天创建定时任务和网页监控，在设置中管理；会话详情页提供执行记录与审批。
- [目标与里程碑](goals.md)：在设置的「目标」页或聊天中管理长期目标与里程碑，不等同于定时执行任务。
- [记忆与 Dream](memory-and-dream.md)：长期记忆查询和管理，以及独立配置的记忆整理。

## 资料与设置 {#profile-and-settings}

助手身份、人设和用户资料的编辑，以及本机主题与助手形象选择、连接维护、真实浏览器入口和 Android 应用更新，见[资料与设置](profile-and-settings.md)。

## 浏览器 {#browser}

服务端提供完整带界面的真实 Google Chrome 浏览器能力，启用与访问范围由配置控制。详见[真实浏览器指南](browser.md)；手机端（`rich-ui`）或网页工作台通过 `POST /api/browser/viewer-ticket` 获取一次性同源票据并在 `/browser/launch` 免登打开 `/browser`（或直接访问 `/browser`），动态切换手机/桌面视口、原生输入和完成人工接管。入口见[资料与设置](profile-and-settings.md)。

## 数据与网络 {#data-and-network}

服务端实例目录保存明文会话、记忆和凭据，应保护目录与备份权限。模型请求会把当前任务所需内容发送给配置的外部模型服务。HTTP 可用于连接，但不会加密 AccessKey、Token 或对话内容。更多设置见[配置说明](configuration.md)。
