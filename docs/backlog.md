# 待实施需求池

这里统一记录已经讨论、但尚未实施的需求。当前实现以源码为准，验收结论以实际执行结果及对应版本报告为准；本文件不是“已经支持”的功能清单。

> 编号规则：REQ-001 至 REQ-010 为旧批次编号，已完成/合并的条目保留编号占用、不回收复用，以便历史讨论记录中的引用仍可对应。新需求从 REQ-012 起继续编号。

## 使用约定

- **讨论不等于开工**。用户认可方案，也不代表立即授权实施；明确要求“先记录、晚点做”的需求保持待实施。
- 后续讨论形成新需求时，先在这里登记；较详细的方案放 `docs/discussions/`，本页保留入口与状态。
- 区分“讨论中”和“方案认可、暂缓实施”，不要把助手建议记成用户定论。
- 开始实施、变更范围或完成验收时更新状态；**完成后移出待实施清单**，在下方“已完成”一节留编号、一句话结论与验收记录链接，需要保留的版本验收记录放 `docs/archive/`，不另建交接文档。
- 不因为登记需求自动创建定时任务、启动后台处理或修改正式数据。

## 待实施

### REQ-018 · 通用信息分析与短信首次接入 —— 方向已确认，待实施

- **已确认：** 服务端复用通用消息分析链路，短信首次接入全面分析、后续增量判断通知；用户偏好统一为所属 Agent 指令，不另建短信专用偏好或重要性分类代码。
- **尚待确定：** 历史读取范围、首轮结果展示和原生批量接入细节；不把此前助手提出的时间范围或“仅导入、分析另点”当作定案。
- **方案与边界：** [通用信息分析与智能体转交建议](discussions/feature-spaces-and-main.md#information-and-agent-handoff)。本轮仅记录，未修改业务代码，不迁移或删除真实数据。

### REQ-019 · Group 最小协作、能力描述与分级路由 —— 默认组批次已实现待验收，保留多组后续

- **最小结构：** Agent 独立，Group 管理成员、默认接收者/协调者、简单路由与协作说明；协调者是组内角色，同一 Agent 可加入多个组，组间讨论与私聊分开。邀请不等于新建 Agent，退出不等于删除 Agent。
- **已确认：** Agent 对外能力描述与内部指令分开；显式 `@` 优先级最高，未指定但意图明确且唯一匹配时自动以用户身份按 `@目标` 投递，不额外确认；模糊或多匹配时展示目标和待发文字，用户确认或选择后再发送，取消不发送。普通聊天由组的默认 Agent 处理。
- **非目标：** 不在模糊或多匹配未确认时调用目标，不做自主邀请、多 Agent 自动分派、层级群组、复杂权限或多级调度，不建设置信度评分体系，不把人机确认扩大为内部通信权限体系，也不绕过既有文件审批。
- **方案与依赖：** 详见[同一确认方案](discussions/feature-spaces-and-main.md#information-and-agent-handoff)，与 REQ-018 按模块串行推进；当前批次实现一个默认组的配置、公开能力、单目标路由与确认卡片；多组创建/管理和跨组独立讨论未实施，不能把本批当作完整多组支持。当前原生设置与失败保稿已验，候选确认完整链路及最新公开能力发现真实模型复验被上游 503 阻塞，不能标为模块已完成；见[本批记录](archive/req-019-group-routing.md)。

### REQ-016 · 默认互信的智能体双向通信 —— 底座与通知来源讨论已验收，保留后续事项

- **用户确认：** 项目内部智能体默认互信，不增加智能体白名单、绑定授权、逐次调用确认或仅 main 可调用的限制；既有凭据保护、文件路径安全与模型文件修改审批不变。
- **已完成批次：** 智能体发现、独立讨论中的请求/回复与追问；目标使用自己的数据、规则和工具，正文由 pi 保存。回复走原调用，不进入普通通知队列；通知绑定仅控制后台主动投递。取消、reset/delete、关闭、真实模型与现有客户端兼容性已验收，见 [首批验收](archive/req-016-space-communication.md)。
- **当前已验收：** 来源卡片「继续处理」与独立讨论原生页面；沿真实通知来源处理，保留普通 main/@ 输入规则，不把评论反馈自动变成执行指令。通知讨论、普通聊天及各条通知草稿分开持有，输入交接后立即清空且保留后续草稿，见[通知续聊记录](archive/req-016-member-navigation.md)。
- **关系与决策：** [Feature 与智能体关系](discussions/feature-spaces-and-main.md#空间双向通信的后续定案)。实现、验收和后续 UI 的状态分别记录，不能因通信底座完成将整个需求标成完成。

- **导航基线：** 当前为「全部」与智能体共用头像栏，点击切换、长按进入相应设置；没有会话列表、成员主页或底部导航。头像状态、最近活跃排序与设备置顶已验收，见 [REQ-017](archive/req-017-agent-domain.md)。不再把被替代的导航或列表摘要列作待开发功能。
- **已收口的设置交互：** 智能体持久创建、短信前台状态刷新与静默结果、新闻偏好跨页草稿及未明保存保护、动态面板原路返回、RSS/Dream 配置折叠与窄屏管理布局，详见[分批记录](archive/req-016-member-navigation.md)。新闻客户端整合后的主视图与横扫状态见 [REQ-017 合并记录](archive/req-017-agent-domain.md)，独立页面分支不属于本轮主线写集。
- **后续待讨论：** 普通智能体未读提示尚无已确认的读取/清除规则；不显示数量、不为「全部」聚合状态的既定取舍不变。是否增加提示及清除时机另行确认，不把历史列表设计直接移植到头像栏。
- **专项待核实：** RSS 添加失败原因、实际订阅采集及文章流程，以负责该页面工作区的当前源码和专项验收为准；历史新闻窄屏建议及旧原生脚本不能代表当前问题。本条只保留入口，不在本轮修改或重复接管该页面。

## 已完成

以下需求已实施验收并移出待实施清单；编号保留占用，历史讨论中的引用仍可对应。当前行为以源码、运行时 `/docs` 与 `/openapi.json` 为准。

### REQ-014 · Feature 独立智能体与可配置的交互承接智能体 —— 已完成

- **完成日期：** 2026-11-02。
- **实施结果：** 新闻/短信独立存储，默认 main 承接交互，可显式改绑已有普通智能体；侧栏「功能」统一管理。新闻带到聊天讨论，短信后台过滤与来源通知，受限来源工具和气泡反馈回流原功能；不迁移真实数据。
- **验收记录与限制：** [REQ-014 独立功能与交互承接智能体](archive/req-014-feature-spaces.md)；[产品关系基线](discussions/feature-spaces-and-main.md)。

### REQ-015 · 智能体独立页面与私有工作区编辑 —— 已完成

- **完成日期：** 2026-11-02。
- **实施结果：** 底部智能体独立页收敛当前智能体的文件/规则/技能/既有信息处理/维护，全局设置移至左侧抽屉；原生目录、Markdown 阅读/源码编辑与完整保存确认、草稿/返回保护已完成，不改 Muse 配色。真实后端/外部模型、Android 和隔离独立 APK 已验收；Feature 交互承接改绑仍属 REQ-014，不在本批实现。
- **验收记录：** [REQ-015 智能体导航与文件编辑](archive/req-015-space-workspace.md)。

### REQ-005 · 完整浏览器能力（用户可操作 + Agent 可操作）—— 已完成（V1）

- **完成日期：** 2026-10-25。
- **实施结果：** 服务端提供独立真实浏览器域：系统 Chrome 固定以带 GUI 的真实窗口懒启动、持久 profile、全局标签管理、当前标签 CDP JPEG 帧流、基础输入、`/browser` 调试页，以及与用户共享同一实例的 `navigate` / `snapshot` / `act` / `tab` Agent 工具。移动客户端集成本次明确不在范围内。
- **验收记录：** [浏览器 V1 验收记录](archive/req-005-browser-v1.md)。

### REQ-009 · 长期记忆独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-21。
- **实施结果：** 提升为独立顶层资源 `/api/memories`（GET 列表与检索支持 q 忽略大小写子串搜索、limit 限制条数、sort 支持 updatedAt/createdAt、order 支持 asc/desc，上限 500 条全量返回不分页；GET /:id 单条详情；POST 创建记忆，500 条满额时 409；PATCH /:id 更新记忆内容并自动推进 updatedAt；DELETE /:id 删除记忆返回 `{ ok: true, id }`）。工作区快照 `GET /api/identity` 彻底脱耦并移除 `memories` 字段，彻底移除旧 `/api/agent/memories*` 端点，不作旧字段兼容。

### REQ-010 · 网页监控独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-21。
- **实施结果：** 独立顶层资源 `/api/monitors`（GET 列表支持 agentId 过滤与 createdAt/lastCheckedAt/status 排序，全量返回不分页；GET /:id 详情；POST 新建；POST /:id/control 控制 pause/resume/stop；PATCH /:id 修改 title/url/condition/value/intervalMinutes/originAgentId，若修改 URL 或检测条件/关键词自动重置内容指纹与命中基线；DELETE /:id 彻底删除）。彻底移除旧 `/api/agent/monitors*` 端点及 `GET /api/identity` 快照中的 `monitors` 字段，不作旧字段兼容。

### REQ-007 · 定时任务独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 独立资源 `/api/jobs`（GET 列表支持 agentId 过滤与 nextRunAt/updatedAt/createdAt 排序，全量返回不分页；GET /:id 详情；POST /:id/control 控制 pause/resume/cancel/retry；PATCH /:id 修改 prompt/daily/at/originAgentId 并自动重算 nextRunAt；DELETE /:id 彻底删除）。移除旧 `/api/agent/tasks*` 端点及 `GET /api/identity` 快照中的 `tasks` 字段，不作旧字段兼容。

### REQ-012 · 活动与领域状态的全局 SSE 推送 —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 在 `GET /api/events` 中接入 `activity_updated` 增量事件与 `ready.activities` 全量活跃活动快照；主模型登记、推进、审批等待与完成/中断等生命周期变化实时推送到客户端，无需轮询。

### REQ-011 · 实例配置文件目录统一收拢至 profile/ —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 全局身份、用户画像、Dream 提示词与长期记忆文件统一收拢至 `profile/` 目录（`profile/SOUL.md`、`profile/USER.md`、`profile/DREAM.md`、`profile/memory.json`）；会话目录 `sessions/<agentId>/` 保持既有隔离与扁平结构（`INSTRUCTIONS.md`、`skills.json`、`DREAM.md`、`dream.json`），数据布局单一权威更新，不进行隐式历史迁移。

### REQ-001 · Dream 后台记忆整理 —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 记忆分层（SOUL/USER/会话指令每轮携带、`memory.json` 按需检索 `memory_search`、500 条硬上限）；全局/会话 `DREAM.md` 可继承；主会话默认开启、其他会话默认关闭；每 2 小时后台整理与手动触发；待确认列表；HTTP 契约与 Web 设置页。
- **方案与验收：** [Dream 后台记忆整理](discussions/dream-memory.md)。

### REQ-002 · 智能体重置（保留记忆与工作区）—— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 落地为智能体/会话解耦后的 `POST /api/agents/:agentId/reset`：清空聊天历史、以全新 `sessionId` 重开、作废残留待审批（计数含运行关闭级联取消），保留工作区、`INSTRUCTIONS.md`、技能开关与 Dream 配置；`clearSchedules` 可选级联删除定时任务与监控。同步完成 agent→agent 接口重构与前端迁移说明。
- **迁移说明：** [前端智能体/会话迁移说明](frontend-agent-session-migration.md)。

### REQ-003 · Activity 执行活动 —— 已完成（SSE 推送对接并入 REQ-012）

- **完成日期：** 2026-10-19。
- **实施结果：** 主 Agent 自主登记、完成保护、跨轮继续、真实逐步明细、列表/详情查询（游标分页）。
- **验收记录：** [Activity e2e 验收](archive/2026-10-19-activity-e2e-acceptance.md)；业务规则见 [Activity 执行活动](discussions/activity.md)。
- **遗留：** 与全局 SSE 的状态推送对接随 REQ-012 讨论。

### REQ-004 · 审批决定、执行结果与历史查询 —— 已完成

- **完成日期：** 2026-10-19。
- **实施结果：** `GET /api/approvals`、`GET /api/approvals/pending`、`GET /api/approvals/:id`、`POST /api/approvals/:id/decision`；授权与执行回执分离；历史摘要分页、单项完整详情、完整预览长期保留。
- **业务规则：** [审批接口](discussions/approvals.md)。

### REQ-006 · 全局 SSE 直接推送展示状态 —— 已完成

- **完成日期：** 2026-10-19。
- **实施结果：** `GET /api/events` 的 `ready` / `agent_status_updated` / `approval_pending` / `approval_updated` 与 `GET /api/runs/status`；连接/重连同步当前状态与待审批项，后续直推变化。

### REQ-008 / REQ-013 · 目标（Goals）独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-21。
- **实施结果：** 提升为独立顶层资源 `/api/goals`（GET 列表支持 status、category 过滤与 updatedAt/createdAt 排序，全量返回不分页；GET /:id 单项详情；POST 创建目标；PATCH /:id 更新属性与 status，设为 completed 时自动勾选名下全部未完成里程碑；POST /:id/milestones/:mid/toggle 切换里程碑完成状态；DELETE /:id 删除目标返回 `{ ok: true, id }`）。工作区快照 `GET /api/identity` 彻底脱耦并移除 `goals` 字段，彻底移除旧 `/api/agent/goals*` 端点，不作旧字段兼容。
