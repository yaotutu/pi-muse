# REQ-019 默认组配置与薄路由

## 范围与状态

2026-11-05，当前 `main` 工作区实现批次，**实现待验收，未本地提交、push 或发布**。只配置现有单一默认组，不包含多组创建/切换、跨组讨论或 REQ-018 的短信首次全面分析、增量处理与偏好收敛。

- Agent 公开能力与私有指令分开保存；新闻和短信同样可编辑。`agent` 的 `list` 只增加公开能力说明，不读取其他成员私聊、记忆或内部指令。
- 默认组配置名称、用途、成员、默认回复者和协作说明。默认回复者必须是现有成员；移出成员不删除其私有数据或旧讨论。配置最后一次成功保存生效，不做版本冲突、自动合并或复杂邀请权限。
- 显式 `@` 优先且跳过分类；无目标时用单业务模型的隔离 SDK 判断轮，仅装配 `submit_group_route`，只读取本条消息、组设置与公开能力。明确唯一匹配直接按用户身份投递；模糊/多匹配只发建议；普通聊天交组默认回复者。
- 建议保留原文和候选，确认前不创建目标讨论或执行；确认以新消息 ID 和显式单目标发送，不改成默认 Agent 的后台委派。取消不发送，确认不清除输入框的新草稿。建议仅在当前连接内保留，不增加可靠队列或自动重发。
- 组说明只装配当前组轮次，不改写成员指令或扩大工具/审批权限。通知来源讨论仍跳过组路由并保留原来的独立来源上下文。

## 实现入口

- 服务端 `features/group-chat/routing.ts`、`adapters/pi/group-routing-runner.ts` 与 `adapters/storage/group-routing-repository.ts`。业务 JSON 只保存组配置、公开能力与原有投递索引；目标正文仍由 pi JSONL 持有，路由判断不持久化为聊天。
- 契约唯一来源为 `http/contracts/group-chat.ts` 和当前运行 `/docs`。增加默认组设置、公开能力管理及 `suggestion` SSE；不建立影子 API。
- 移动端 `group/GroupChat.tsx`、`group/group-composer.ts`、`group/routing-settings-store.ts` 与 `group/RoutingSettingsPanel.tsx`。全局设置增加「默认组协作」，智能体设置增加「公开能力」，不恢复底栏或聊天右上角按钮。
- 设置草稿按连接、资源独立保留；写入废弃旧 GET，失败保留草稿，结果未明要求显式回读，不靠离页或自动读取解锁。

## 本次证据与未验范围

证据根目录为工作区 `ui-previews/group-routing/`。没有修改真实实例数据、凭据、签名、版本或另一工作区。

- 核心路由的早期当前源码隔离实例完成真实外部模型验收：显式目标跳过分类、短信明确意图单目标直达、可更换默认回复者、能力重叠只提建议、确认原文与用户身份、私聊历史不变，以及真实路由中的 Stop/断流取消。见 `live-status.json`、`cancel-status.json` 和 `model-traces-initial.json`；这些证据不替代后来补充的公开能力发现与原生确认闭环。
- Android `emulator-5554` 的 Expo Go 加载主工作区 Metro 当前源码、连接独立真实后端：组默认回复者保存、公开能力保存、返回重开保留草稿已通过，见 `native-settings-status.json` 与对应截图。未使用另一执行者的 `emulator-5556` 或新闻工作区 Metro。
- 随后的真实上游调用返回 **HTTP 503**。当前公开能力发现真实模型复验未完成；原生候选确认、确认后保留下一条草稿和取消建议的完整链路同样待验。不能以单元测试、历史截图或合成 SSE 替代。见 `discovery-initial-status.json`、`model-traces-discovery-failure.json`、`model-traces-unavailable.json` 和 `native-routing-status.json`。最后一次源码契约重启后没有继续重复模型请求。
- 原生失败分支已证明：路由失败没有目标执行，原文通过权威回读恢复到输入框，没有自动重发；真实失败轮次保留，不删数据制造成功。能力描述测试修改已还原，组默认回复者已恢复 main。
- 额外窄屏检查尚未完成：改变显示参数后未进入目标页面，Expo Go 出现 `EventEmitter` 运行时错误，不把它冒充布局验收。已核实尺寸与字号恢复为默认值；恢复环境后再验，不在本批顺带修改原生依赖或增加兼容分支。
- 复查修正了原文契约：组发送只拒绝全空白正文，不再 trim 实际内容。含首尾空格和换行的建议、确认正文保持一致，避免客户端因原文不匹配而丢弃有效建议；配套 HTTP/SDK 与客户端回归已补充。
- 最终源码的服务端 `pnpm check` 通过：690 项 unit/integration、39 项本地 E2E，包含 build、Web 构建和差异检查；移动端 lint/typecheck 与 726 项测试通过。见 `server-check-final-source.log`、`mobile-tests-final-source.log`。这些自动化门禁不能替代上述真实模型和原生待验项。
- 文档构建与当前 API 文档渲染见 `docs-build-current.log`、`docs-render.json`；窄屏的未完成边界见 `native-layout-status.json`。本批没有验证 iOS 或发布 APK。

## 新闻 UI 合并后的复验

同日按用户要求将新闻 UI 分支 `b789928` 合入客户端主分支，合并提交 `556fa29`；新闻手册独立同步于服务端 `13d9f8a`。REQ-019 代码仍未提交，临时保存后已恢复，未改服务端业务源码。冲突处理同时保留新闻详情整页显隐、头像状态与最近活动排序，并增加组合回归断言。

- 合并并恢复路由后的客户端 lint/typecheck 与 724 项测试通过；数量变化来自新闻分支去掉评论操作相关测试，不是跳过失败项。当前 `/docs` 浏览器渲染、中英文新闻手册构建与引用检查通过，见 `ui-previews/ui-merge-current/`。
- Android 清理 Metro 缓存并重新启动 Expo Go 后，当前源码的空新闻列表、筛选、来源页返回和路由配置入口通过；切换源码时的旧内存快照不作为新协议输入，不增加历史字段兼容分支。非空文章反馈和窄屏仍未复验。
- 本次原生显式发送只接纳一次，跳过路由分类、私聊历史不变；真实外部模型仍返回 503，无工具执行、无自动重发。公开能力发现及候选确认闭环仍待验，不能以本次 Git 合并代替业务验收。证据为 `native-model-status.json` 和 `model-traces.json`。

## 收口条件

1. 外部模型恢复后，先核对既有失败轮次，不重放原请求；用新的验收消息验证默认 Agent 通过 `agent list` 读取最新公开能力。
2. 原生完成能力重叠建议 → 展示原文/候选 → 单目标确认 → 目标真实回复、新草稿保留，以及另一条建议取消无执行。
3. 恢复原生验收环境后补窄屏检查；必要复验与文档状态同步后，才能将默认组批次标为已验收并分别本地提交。多组与 REQ-018 继续保留待办，不扩大本批结论。


## 真实模型与原生完整验收（2026-11-05）

上游 503 错误定位为 `minimax-cn/MiniMax-M2.5` 额度耗尽（上游网关映射 402/429 为 503）。按用户指令将模型切换为 `cx/gpt-6-sol` 后启动独立测试后端：
1. **清理工作树与分支**：删除 `news-ux` worktree 与本地分支，服务端与客户端均保持唯一干净的 `main` 分支。
2. **公开能力发现复验通过**：`local-main` 通过 `agent(action="list")` 工具成功发现 `sms-internal` 的公开能力并生成中文说明，无越权调用或私聊泄漏，见 `discovery-status.json`。
3. **Android 原生路由与确认闭环通过**：
   - 短信与新闻能力重叠时，模型通过 `submit_group_route` 返回 `mode: "confirm"`，客户端在消息列表末尾展示「这条消息交给谁？」卡片及候选按钮。
   - 输入框已有的新草稿（`NEXT_DRAFT_KEEP`）在确认转交期间完整保留，不被清空或覆盖。
   - 点击「确认转交给短信」后，原文以用户身份投递至 `@短信` 并获得真实回复。
   - 第二条消息点击「取消本次转交」，不产生任何目标讨论与副作用，轮次保持一致。
   - 顶部头像栏按最近活跃顺序将 `短信` 自动前置。
   - 证据见 `ui-previews/group-routing/routing-suggestion-android.png` 与 `ui-previews/group-routing/routing-confirmed-android.png`。
4. **门禁全量通过**：
   - 服务端 `pnpm check`（690 项单元/集成测试、39 项 E2E、Web 构建、差异检查）全部通过。
   - 服务端 `pnpm docs:build` VitePress 构建通过。
   - 客户端 `expo lint`、`tsc --noEmit`、724 项自动化测试全部通过。
