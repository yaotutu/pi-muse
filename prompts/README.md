# Pi Muse 系统提示词目录（System Prompts Index）

本目录是 Pi Muse 服务端**唯一托管的所有系统提示词事实源**（全英文编写，内置跨语言输出支持，默认面向中文用户体验返回简体中文内容）。构建时会一并复制到 `dist/prompts/`，开发模式下实时从磁盘读取，不支持数据目录覆盖。

## 统一三层结构（所有 Agent 同构）

每次调用大模型时，服务端统一按三层拼装上下文：

1. **系统提示词（`prompts/<agent>/*.md`）**：本目录中的英文模板，定义角色定位、默认决策基线（如短信的「默认静默」）、安全红线与输出语言约束。
2. **用户专属指令 + 长期行为习惯（放入 `system` 后半段）**：
   - 用户的持久化指令与人设文档：全部 5 份工作区托管 Markdown（`workspace/assistant/{SOUL,USER,INSTRUCTIONS}.md`、`workspace/domains/sms/INSTRUCTIONS.md`、`workspace/domains/news/INSTRUCTIONS.md`）均支持在**文件最顶部**通过标准 YAML Frontmatter `include:` 引用同目录及 `workspace/` 内的相对路径纯文本（支持列表或单行路径，最多 5 层嵌套、自动环路去重与 60,000 字符展开上限；缺失/越界/非纯文本静默跳过不报错；HTTP 读取/保存保持原始文本，只在注入大模型前实时展开）；
   - 通用习惯引擎维护的行为习惯条目：`Consolidated User Habits`（`HabitItem[]`，严禁解析 `include:`，防止反向读取工作区其他文件）。
3. **当次待处理输入 + 未消化反馈热缓冲（放入 `user`）**：用户的即时对话、或当批次待判定的原始短信/新闻与尚未定期归纳进长期习惯的近期反馈热缓冲样本（明确包在 `UNTRUSTED INPUT DATA` 边界内防注入）。

## 文件清单与作用说明

| 文件 | 所属 Agent / 模块 | 作用与关键机制 |
| --- | --- | --- |
| [assistant/base.md](assistant/base.md) | 主对话助手 | 基础人设骨架、工作区文件边界、能力与安全总约束 |
| [assistant/domain-agents.md](assistant/domain-agents.md) | 主对话助手 | 后台领域 Agent 列表、通知卡片隔离说明、`get_instructions` / `update_instructions` 路由规约 |
| [assistant/subagent-child.md](assistant/subagent-child.md) | 通用子代理（Subagent） | 派生子代理时的角色指令包装段 |
| `assistant/tools/*.md` | 主对话各能力工具 | 随当轮实际可用工具动态拼装（`files` / `current-time` / `write` / `database` / `instructions` / `skills` / `activity` / `memory` / `schedule` / `monitor` / `goal` / `weather` / `web` / `browser`） |
| [habits/consolidate.md](habits/consolidate.md) | 通用习惯归纳 Worker | 基于消费游标从各领域未消化反馈热缓冲中定期提炼 `add/edit/delete` 行为习惯，不覆盖显式指令、不记录一次性验证码/链接 |
| [sms/realtime.md](sms/realtime.md) | 短信实时单周期 Worker | **默认静默（Default-Silent）基线 + 四级优先级**（用户指令 > 近期未消化反馈 > 已归纳长期习惯 > 默认静默），默认输出简体中文通知与理由 |
| [sms/archive.md](sms/archive.md) | 短信历史归档 Worker | 批量历史分类并可选向习惯库增量提交 `habitOperations`，严禁单批直接发通知 |
| [sms/briefing.md](sms/briefing.md) | 短信历史归档简报 Worker | 归档队列清零后生成至多 1 条 `<= 1200` 字自然语言中文总览简报（严禁透出内部字段名或系统 ID） |
| [news/screening.md](news/screening.md) | 新闻 RSS 筛选 Worker | 按新闻规则、已归纳习惯与近期未消化文章反馈筛选值得推荐的文章 |
| [dream/consolidate.md](dream/consolidate.md) | Dream 记忆整理 Worker | 对话沉淀分流规范（区分全局 `USER` / `SOUL` / `INSTRUCTIONS` / `MEMORY` 与待确认队列） |
| [dream/hard-rules.md](dream/hard-rules.md) | Dream 记忆整理 Worker | 记忆整理不可覆盖的硬性安全与权限边界约束 |
