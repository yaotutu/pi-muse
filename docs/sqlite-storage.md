# 服务端 SQLite 约定

本期新闻使用独立 `news.sqlite`，默认库为 `main.sqlite`。Agent 可操作两库全部业务表，无库/表角色和逐次 SQL 审批。其他尚未迁移的领域继续使用当前存储；pi 会话历史和客户端不在本次范围。

## 连接与生命周期

- 路径只在 `src/adapters/storage/data-layout.ts` 声明，由 bootstrap 统一打开并注入。新闻 repository、处理管线和 `database` 工具共用同一个 Managed 实例；main 按首次实际访问惰性打开。
- `openSqliteDatabase()` 基于 Node.js 24.18.0+ 内置 `node:sqlite`，默认 WAL、synchronous=FULL、foreign_keys=ON、5000ms busy timeout。库/边车为 0600，新建目录为 0700，不隐式 chmod 已有目标目录。
- 运行时读取、异步读改写和工具执行均经过该实例的 `serialize()`；`transaction()` 只包同步短事务，不得 await 模型、网络或人工决定。直接持有原生连接不是另开 writer 的理由。
- 关闭先拒绝新入口、收敛运行和在途请求，再等队列并关库。提交成功后的权限收紧/回执错误仍可能导致结果未知，不自动重放写入。
- 当前路径检查覆盖库、边车及直接父目录。DATA_DIR 的更高层路径来自受信启动配置；这不是对恶意本机进程竞态的 OS 沙箱。Agent 不能通过工具传入任意文件路径或加载扩展。

## 结构与演进

- 表、列和索引用 snake_case，领域表用模块前缀。新闻独立是特例；新模块默认进入 main，不默认每功能分库。
- 既有对外 ID、时间和含义不变。时间沿用 UTC ISO 8601，业务发生时间与系统接纳时间分开；数值及单位分列。
- 关系使用外键，幂等使用唯一约束；删除规则须显式决定。历史快照不错误依赖配置记录继续存在，不默认级联删除。
- SQL 显式选择列，更新只写已知列；Agent 增加的列/表不应被业务全量重写抹去。JSON 可用于确有必要的变形 payload，不把整个业务聚合塞成一行文档。
- 当前新闻以 user_version=1 校验 schema，news_meta 记录来源及导入状态。缺表、缺单例、未知版本或未完成导入明确失败，不自动补成空库。
- main 目前没有内置业务 schema。后续多个模块进入 main 时，应采用按模块登记的迁移账本（可用 app_schema_migrations，记录 module/version/name/checksum/applied_at），避免多个模块各自独占 PRAGMA user_version；这项账本尚未在本期建表或实现。
- Agent 可自由改结构，但协作约定是长期结构与正式迁移保持同步，不伪造版本完成记录。已有结构不符时停止并说明，不用 CREATE IF NOT EXISTS 掩盖冲突。

## 新闻表含义

| 表 | 含义 |
| --- | --- |
| news_sources | 当前订阅配置和健康状态，删除不清历史文章 |
| news_articles | 原始条目及来源快照，source+external_id 唯一；received_at 对应公开文章时间，accepted_at 为接纳时间 |
| news_article_feedback | 每篇当前 reaction/saved；position 表示反馈触达顺序，不是点赞次数 |
| news_article_comments | 评论身份、内容、时间和每篇内部顺序 |
| news_analysis_runs | 处理批次、模型状态、时间；罕见历史 publications 以保真 payload 保留 |
| news_analysis_run_items | 批次成员及顺序 |
| news_analysis_decisions | 每批对每篇的决定与理由，既有推荐不因反馈立即重算 |
| news_state | 新闻设置、偏好摘要及少量单例状态；明确规则仍经 main 指令入口保存 |
| news_meta | 来源与导入标记，不是另一份新闻数据 |

现有共享 InformationService 仍使用聚合规则读改写，SQLite 提交按行 diff，尚未把推荐/筛选/分页全部改为 SQL 查询。不能宣称本期已完成 SQL 查询优化。

## 导入、恢复与 Agent 工具

- `scripts/import-news-sqlite.ts` 只读源、排他创建新目标，严格校验后导入；数据回读核对与 imported 完成标记同事务提交。中断的 importing 库不能启动为空新闻。真实数据导入/删除仍需明确授权。
- 新实例无旧 JSON 才初始化；旧 JSON 仅检查存在性及来源关系，不在运行时解析为业务事实或继续双写。明确导入后的 SQLite 是唯一新闻权威。
- 备份使用 SQLite 一致快照/在线备份，不在写入中只复制主文件。数据库事务不能回滚模型、通知或物理文件副作用。
- `database` 通过 list/schema/execute 发现和操作托管库。SQL 输出有明确预算和截断标记，不能假装完整；同步语句不保证可硬中断。未知写结果先查询，不自动重试。
- 库内内容是不可信数据，改一行状态不等于外部动作已发生。数据库自由度不提供任意宿主文件、进程或文件审批绕过能力。
