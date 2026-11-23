# SQLite 存储约定

服务端结构化业务状态分两类存放：**机器维护的状态进 SQLite，人维护的内容留纯文本或 JSON 配置**。新闻使用独立数据库 `news.sqlite`，其余模块共用默认库 `main.sqlite`；聊天历史仍由 pi 管理为 JSONL，客户端存储不在本约定范围内。

## 判据

- **SQLite**：由机器写入、需要按条件查询/排序/筛选、存在实体关系或唯一约束、需要与其它状态同事务提交、或会随时间增长需要索引。
- **纯文本文件**：内容是给人读、给人手改的短文档（人设、用户资料、会话规则、记忆条目）。
- **JSON 文件**：配置而不是业务事实（服务配置、身份设置）。

前缀与表名不能替代归属判断：`news_` 表示新闻独立分库，是当前唯一例外。

## 连接与生命周期

- 路径只在 `src/adapters/storage/data-layout.ts` 声明。`main.sqlite` 在启动时打开并校验结构；`news.sqlite` 由新闻仓储打开。两者都由 bootstrap 统一注入，不允许各开 writer。
- `openSqliteDatabase()` 基于 Node.js 24.18.0+ 内置 `node:sqlite`：WAL、`synchronous=FULL`、外键开启、5000ms busy timeout；库与边车 0600，新建目录 0700，不隐式 chmod 已有目录。
- 读改写与工具执行都经过该实例的 `serialize()` 队列；`transaction()` 只包同步短事务，事务内不得 await 模型、网络或人工决定。
- 关闭先拒绝新入口、收敛运行与在途请求，再等队列并关库。提交后的权限收紧或回执错误仍可能让结果未知，不自动重放写入。

## 模块与版本账本

`main.sqlite` 用按模块登记的账本 `app_schema_migrations(module, version, applied_at)`，而不是 `PRAGMA user_version`——后者只能表达一个全局版本，多模块无法区分。

- 账本登记过的模块必须表齐全且版本一致；缺表、版本不符、发现未登记却已存在的表都视为结构损坏，明确失败，不补默认值、不整库重建。
- 新建空库时按注册顺序建立全部模块并一次登记。
- 版本变化必须由代码显式提供新 DDL；本约定不提供自动迁移脚本。

新闻库 `news.sqlite` 独立使用自己的 `user_version`，不进入该账本。

## 表与归属

| 库 | 表 | 归属 |
| --- | --- | --- |
| `news.sqlite` | `news_sources`、`news_articles`、`news_article_feedback`、`news_article_comments`、`news_analysis_runs`、`news_analysis_run_items`、`news_analysis_decisions`、`news_state`、`news_meta` | 新闻（`user_version = 3`：已清理 `news_state`/`news_analysis_runs` 历史废弃列；筛后有界保留最多 2,000 篇无反馈文章，含用户反馈的文章永不裁剪） |
| `main.sqlite` | `jobs` | 定时任务 |
| `main.sqlite` | `goals`、`goal_milestones` | 目标 |
| `main.sqlite` | `actions` | 审批记录与执行回执 |
| `main.sqlite` | `sms_state`、`sms_items`、`sms_runs`、`sms_run_items`、`sms_decisions` | 短信管线（模块 `v4`：直接 SQL 查询/事务读写与游标分页，建有 `(queue, status, position)`、`(accepted_at DESC, id DESC)`、`(started_at DESC, id DESC)`、`(item_id, run_id)` 索引，并有界清理终态历史同时保留待处理/运行中/失败条目） |
| `main.sqlite` | `habit_domains`、`habit_items`、`habit_signals` | 通用用户习惯引擎（消费游标、长期行为习惯条文及按 `seq` 保序的未消化反馈热缓冲） |
| `main.sqlite` | `dream_state`、`dream_cursors`、`dream_pending` | Dream 机器状态 |
| `main.sqlite` | `message_feedback_events`、`message_feedback_states` | 消息级用户行为（点赞/点踩、`saved` 收藏、评论 append-only 事件流与索引状态） |
| `main.sqlite` | `app_schema_migrations` | 模块版本账本 |

规则：

- 业务 ID 保持不变，时间沿用 UTC ISO 8601，业务发生时间与系统接纳时间分开。
- 关系用外键，幂等用唯一约束；删除规则逐项明确。历史快照不错误依赖配置记录继续存在。
- 显式选择列并只改受影响行（`news.sqlite` 按行 diff 提交，`sms_*` 直接 SQL 定向读写/分页），不整表清空重写，Agent 增加的列与自建表不被抹掉。
- JSON 只用于确有必要的变形 payload，不把整个业务聚合塞成一行。
- 会话仍在 JSON/JSONL，因此 `origin_session_id` 等只是字符串，不建跨存储外键；删除会话由领域服务显式清理。

## 留在文件里的数据

| 数据 | 形式 | 说明 |
| --- | --- | --- |
| `workspace/assistant/{SOUL,USER}.md` | Markdown | 全局助手人设与用户资料 |
| `workspace/assistant/INSTRUCTIONS.md`、`workspace/domains/{sms,news}/INSTRUCTIONS.md` | Markdown | 主助手与各领域 Agent 的用户指令 |
| `prompts/**`（随仓库发布） | Markdown | 统一系统提示词模板（含 Dream、短信、新闻、主助手与工具说明） |
| `profile/memory.md` | Markdown | 长期记忆条目，带稳定 id 供按 id 修改/删除 |
| `profile/identity.json` | JSON | 身份设置，属于配置 |
| `monitors.json` | JSON | 网页监控本次不迁数据库 |
| `sessions.json`、`messages/**`、`sessions/<id>/skills.json` | JSON | 会话域整体不动 |
| `workspace/**`、`skills/**`、`subagents/**`、`companions/**`、`browser/**`、`traces/**` | 文件 | 内容资产与诊断 |
| `config.json`、`auth.key`、`agent/auth.json` | 配置/密钥 | 不入普通数据库 |

## 导入与恢复

- 本次改造不提供旧 JSON 导入器；切换时按用户授权清空旧业务数据，历史数据无保留价值。
- 数据库事务只覆盖库内更新，不能回滚模型调用、通知投递或物理文件写入。
- 备份使用一致快照或在线备份，不在写入中只复制主数据库文件而遗漏 WAL。
