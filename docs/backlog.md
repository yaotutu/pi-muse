# 待实施需求池

这里统一记录已经讨论、但尚未实施的需求。当前实现以源码为准，验收结论以实际执行结果及对应版本报告为准；本文件不是“已经支持”的功能清单。

> 编号规则：REQ-001 至 REQ-010 为旧批次编号，已完成/合并的条目保留编号占用、不回收复用，以便历史讨论记录中的引用仍可对应。新需求从 REQ-012 起继续编号。

## 使用约定

- **讨论不等于开工**。用户认可方案，也不代表立即授权实施；明确要求“先记录、晚点做”的需求保持待实施。
- 后续讨论形成新需求时，先在这里登记；较详细的方案放 `docs/discussions/`，本页保留入口与状态。
- 区分“讨论中”和“方案认可、暂缓实施”，不要把助手建议记成用户定论。
- 开始实施、变更范围或完成验收时更新状态；**完成后移出待实施清单**，在下方“已完成”一节留编号、一句话结论与验收记录链接，需要保留的版本验收记录放 `docs/archive/`，不另建交接文档。
- 不因为登记需求自动创建定时任务、启动后台处理或修改正式数据。

## 当前架构替代说明

单主助手、多会话 clean break 正在本分支实施，尚待主会话统一验收。它废止 REQ-014 的功能身份与通知改绑、REQ-015 的独立身份/私有工作区、REQ-016 的双向通信与独立讨论、REQ-017 的多身份导航，以及 REQ-019 的默认组/多组路由与管理。以上不再作为后续实施授权；历史验收证据原样保留，不能证明新架构通过。

## 待实施

- RSS 历史故障归因和后续边界优化仍暂缓：错误分类、坏条目整源失败策略、URL 别名/fragment 去重、忙时重排和非法 JSON 行为。见[原核实记录](archive/2026-11-05-news-rss-verification.md)。默认 SSRF 防护不因本次重构改变。

## 已完成

以下需求已实施验收并移出待实施清单；编号保留占用，历史讨论中的引用仍可对应。当前行为以源码、运行时 `/docs` 与 `/openapi.json` 为准。

### REQ-019 · 已被单主助手多会话架构废止

组路由与多组后续整体作废。旧版本记录仅供历史核对：[原验收](archive/req-019-group-routing.md)。

### REQ-018 · 通用信息分析与首轮短信导入 —— 已完成

- **完成日期：** 2026-11-05。
- **实施结果：** 过滤规则与偏好完全统一为 main 会话指令（`INSTRUCTIONS.md`），无独立数据库或标签；实现 `initial_summary`（首轮历史积压全面分析，多项待办聚合成单条结构化汇总通知）与 `incremental`（后续单条增量判断，重要单条通知，营销广告静默）两级分析模式；客户端提供「+ 批量导入历史短信」一键上报并自动触发分析，条目清晰标注待分析/分析中/已分析状态。
- **验收记录：** [REQ-018 通用信息分析与首轮短信导入](archive/req-018-information-sms.md)。

### REQ-014 · 已被单主助手多会话架构废止

独立功能身份与可改绑通知目标整体作废。旧版本记录仅供历史核对：[原验收](archive/req-014-feature-spaces.md)。

### REQ-015 · 已被单主助手多会话架构废止

独立身份页面与私有工作区整体作废；改为会话配置与全局工作区。旧版本记录仅供历史核对：[原验收](archive/req-015-space-workspace.md)。

### REQ-005 · 完整浏览器能力（用户可操作 + Agent 可操作）—— 已完成（V1）

- **完成日期：** 2026-10-25。
- **实施结果：** 服务端提供独立真实浏览器域：系统 Chrome 固定以带 GUI 的真实窗口懒启动、持久 profile、全局标签管理、当前标签 CDP JPEG 帧流、基础输入、`/browser` 调试页，以及与用户共享同一实例的 `navigate` / `snapshot` / `act` / `tab` Agent 工具。移动客户端集成本次明确不在范围内。
- **验收记录：** [浏览器 V1 验收记录](archive/req-005-browser-v1.md)。

### REQ-009 · 长期记忆独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-21。
- **实施结果：** 提升为独立顶层资源 `/api/memories`（GET 列表与检索支持 q 忽略大小写子串搜索、limit 限制条数、sort 支持 updatedAt/createdAt、order 支持 asc/desc，上限 500 条全量返回不分页；GET /:id 单条详情；POST 创建记忆，500 条满额时 409；PATCH /:id 更新记忆内容并自动推进 updatedAt；DELETE /:id 删除记忆返回 `{ ok: true, id }`）。工作区快照 `GET /api/identity` 彻底脱耦并移除 `memories` 字段，彻底移除旧 `/api/agent/memories*` 端点，不作旧字段兼容。

### REQ-010 · 网页监控独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-21。
- **实施结果：** 独立顶层资源 `/api/monitors`（GET 列表支持 sessionId 过滤与 createdAt/lastCheckedAt/status 排序，全量返回不分页；GET /:id 详情；POST 新建；POST /:id/control 控制 pause/resume/stop；PATCH /:id 修改 title/url/condition/value/intervalMinutes/originSessionId，若修改 URL 或检测条件/关键词自动重置内容指纹与命中基线；DELETE /:id 彻底删除）。彻底移除旧 `/api/agent/monitors*` 端点及 `GET /api/identity` 快照中的 `monitors` 字段，不作旧字段兼容。

### REQ-007 · 定时任务独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 独立资源 `/api/jobs`（GET 列表支持 sessionId 过滤与 nextRunAt/updatedAt/createdAt 排序，全量返回不分页；GET /:id 详情；POST /:id/control 控制 pause/resume/cancel/retry；PATCH /:id 修改 prompt/daily/at/originSessionId 并自动重算 nextRunAt；DELETE /:id 彻底删除）。移除旧 `/api/agent/tasks*` 端点及 `GET /api/identity` 快照中的 `tasks` 字段，不作旧字段兼容。

### REQ-012 · 活动与领域状态的全局 SSE 推送 —— 已完成

- **完成日期：** 2026-10-20。
- **实施结果：** 在 `GET /api/events` 中接入 `activity_updated` 增量事件与 `ready.activities` 全量活跃活动快照；主模型登记、推进、审批等待与完成/中断等生命周期变化实时推送到客户端，无需轮询。

### REQ-011 · 实例配置文件目录统一收拢至 profile/ —— 已完成

- **完成日期：** 2026-10-20。
- **当前替代：** profile 保存全局资料与 Dream 配置；会话目录仅保存正文、指令与技能覆盖，不进行隐式迁移。

### REQ-001 · Dream 后台记忆整理 —— 已完成

- **完成日期：** 2026-10-20。
- **当前替代：** 全局 Dream 配置/游标/待决项，逐会话整理；SOUL/USER 与记忆全局，指令属于来源会话。
- **方案与验收：** [Dream 后台记忆整理](discussions/dream-memory.md)。

### REQ-002 · 会话重置（由新会话领域替代）

公开 id 保持不变，内部 pi 身份换新，清空历史/反馈并取消审批；标题、规则、技能覆盖与全局工作区保留。可选清理来源任务/监控。当前结果以生成契约为准，本次仍待统一验收。

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
- **实施结果：** `GET /api/events` 的 `ready` / `session_status_updated` / `approval_pending` / `approval_updated` 与 `GET /api/runs/status`；连接/重连同步当前状态与待审批项，后续直推变化。

### REQ-008 / REQ-013 · 目标（Goals）独立查询与管理接口 —— 已完成

- **完成日期：** 2026-10-21。
- **实施结果：** 提升为独立顶层资源 `/api/goals`（GET 列表支持 status、category 过滤与 updatedAt/createdAt 排序，全量返回不分页；GET /:id 单项详情；POST 创建目标；PATCH /:id 更新属性与 status，设为 completed 时自动勾选名下全部未完成里程碑；POST /:id/milestones/:mid/toggle 切换里程碑完成状态；DELETE /:id 删除目标返回 `{ ok: true, id }`）。工作区快照 `GET /api/identity` 彻底脱耦并移除 `goals` 字段，彻底移除旧 `/api/agent/goals*` 端点，不作旧字段兼容。
