# REQ-018 通用信息分析与首轮短信导入

## 范围与实现

2026-11-05，当前 `main` 工作区实现并验收。

- **偏好与智能体指令单一事实来源**：短信信息处理偏好与 `sms-internal` 智能体的专属指令（`sessions/sms-internal/INSTRUCTIONS.md`）完全统一。`getPreferences` 与 `savePreferences` 直接读写智能体指令，移除并行的分类标签或独立存储，保证指令即偏好。
- **两级分析模式**：
  - `initial_summary`（首轮全面分析）：用户首次开启或批量导入历史短信时，模型全面分析积压的所有条目，将所有值得关注的提醒（快递取件码、未缴账单、航班行程等）聚合成一条结构化「待办汇总」通知投递给承接智能体（默认为 main），避免历史短信并发刷屏。
  - `incremental`（增量评估）：首轮积压处理完毕后状态置为 `initialAnalysisCompleted = true`；后续新收到的单条或少量短信按增量模式评估，仅在有行动价值时发送单条简洁通知，广告与营销短信保持 `silent`。
- **状态不变量**：`InformationState` 增加 `initialAnalysisCompleted: boolean` 字段，`InformationRun` 增加 `kind: "initial_summary" | "incremental"` 标识。待处理积压条目清空时自动完成首轮标记。
- **默认指令初始化**：服务启动时若 `sms-internal` 指令为空，自动写入规范的中文短信过滤与通知规则（关注快递、验证码、账单，忽略营销广告，严格遵循用户偏好）。
- **客户端交互**：
  - `SmsSettingsCard` 将「过滤指示与偏好」说明与 `INSTRUCTIONS.md` 统一。
  - 增加「+ 批量导入历史短信」快捷样本按钮，通过 `ingestBatch` 方法批量上报并自动触发首轮全面分析，无需用户重复手动触发。
  - 条目状态清晰标识「待分析 / 分析中 / 已分析 / 分析失败」。

## 验证与证据

证据保存在工作区 `ui-previews/sms-analysis/`，不将临时数据或凭据纳入版本管理。

- **独立真实后端与外部大模型验收**（`cx/gpt-6-sol`，端口 12351，`live-server.mjs`）：
  - 步骤 1：核对 `sms-internal` 默认指令已注入。
  - 步骤 2：批量导入 5 条历史短信（3 条重要待办、2 条广告营销），系统执行 `initial_summary` 首轮全面分析。外部模型成功返回 1 条聚合汇总通知：
    > `待办汇总：招商银行信用卡本期账单 ¥3,280，11月10日还款；国航 CA1831 航班短信称次日 08:30 起飞，请提前两小时到首都机场 T3 办理登机；顺丰包裹已到菜鸟驿站，取件码 3-4-2018，请及时领取。`
    通知成功通过投递管道发送至 `local-main`，附带真实 `featureSource` 来源信息。
  - 步骤 3：增量接收单条中通快递短信，系统执行 `incremental` 模式，输出单条即时提醒：
    > `中通快递已到菜鸟驿站，取件码：5-1-8820。`
  - 步骤 4：更新过滤偏好为「不关注快递取件码」，随后增量接收顺丰快递短信，模型判定为 `silent` 并记录原因（`快递取件短信，按用户偏好一律不通知。`），未产生通知。
  - 证据见 `live-status.json` 与 `model-traces.json`。
- **Android 原生验收**（`emulator-5554`，API 36）：
  - 聚合通知卡片在「全部」和私聊中正常渲染，展示来源与「继续处理 · 短信」入口。
  - 短信设置页正常显示「过滤规则与偏好」，内容与当前指令一致。
  - 批量导入按钮与样本短信触发正常，历史列表状态卡片显示「已分析」与「分析中」。
  - 截图见：
    - `android-group-notifications.png`
    - `android-sms-settings.png`
    - `android-sms-batch-buttons.png`
    - `android-sms-items-list.png`
    - `android-sms-analyzed-cards.png`
- **自动化门禁**：
  - 服务端 `pnpm check` 全量通过（691 项 unit/integration、39 项 E2E、Web 构建、差异检查）。
  - 移动端 `pnpm lint`、`pnpm typecheck` 及 725 项测试全量通过。
