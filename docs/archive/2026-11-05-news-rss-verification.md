# REQ-016 RSS 专项核实（2026-11-05）

针对 backlog「RSS 添加失败原因、实际订阅采集及文章流程」的专项核实记录。方法：源码链路调查（委派只读执行者，主会话逐条抽查 file:line）+ 真实链路验收（隔离实例、真实外部模型、真实公网 RSS）。本记录保留结论与证据边界，不构成新需求的实施授权。

## 结论

1. **「RSS 添加失败」在当前源码 + 当前网络环境下未复现为产品缺陷；历史失败主因降级为有证据支持的候选因素：Fake-IP DNS 与 SSRF 默认防护的组合，历史根因未证实**。已有证据限于：本机 DNS 对公网域名返回 `198.18.0.0/15` 网段地址（实测 sspai.com→198.18.7.239 等）；`shared/public-host.ts` 阻断表命中后在发请求前即拒绝（"Blocked private address"）；隔离验收实例显式 `--allow-private-targets` 放行后全链路通过，方向上与该候选一致。但本轮未在默认防护下复现历史失败，也没有历史请求日志或共享实例配置验证，故不宣称历史根因已确认，默认（未放行）环境也未验证通过。添加路径将 DNS/SSRF 拒绝与超时/DNS/HTTP 错误统一包装为 400 `RSS source fetch or parse failed`（`features/news/service.ts:74-80`），用户看不到真实原因。
2. **真实全链路验收 5/5 通过**（修正过时断言后）：源添加、3 篇真实文章抓取、真实模型推荐 2 篇、反馈进入下一轮且 learnedNotes 增长、删源保留文章、主聊天隔离、重启持久化。真实外部模型请求 4 次、结构化提交 2 次；证据 `/var/folders/.../pi-muse-news-live-HRrOJc/summary.json`（服务身份 commit `7a8d8a4`、mode source）。
3. **发现并修正 live 脚本自身过时断言**：`tests/live/news.ts` 冷启动与重启两处仍预期 `news-internal` 不在 `/api/agents` 且 instructions 404，属 REQ-014 前旧设计；当前 `create-service.ts:342 → news.initialize() → ensureInternalAgent()` 启动即建内置智能体并写默认指令（客户端也按正式成员展示）。行为无回归，测试已改为断言在场 + 默认指令非空，`docs/testing.md` 同步。首次运行被该断言挡在第一步，且验收曾以管道 `tail` 承接导致退出码失真——教训已记：live runner 不接管道，以 node 原始退出码为准。
4. **采集与文章流程核实为按设计工作**：添加只验证源不接纳文章；手动 refresh 串行逐源抓取（单源失败记 `lastError` 继续其他源）、全程锁（重复调用 409）、同步返回不等待模型（InformationScheduler 500ms 扫描独立运行，新闻 batchWindow=0）；failed 条目仅在全部源处理完后重置；30 分钟定时轮不重排 failed。文章按 `(source, externalId)` 去重。

## 遗留观察（未确认缺陷，待用户决策，不入本轮实施）

以下为调查发现的观察点，静态分支属实、真实竞态或产品语义未定，按 backlog 规则登记不等于开工：

- **失败可观察性**（中）：DNS/SSRF 拒绝、HTTP 403、超时等统一压成同一 400 文案；源级 `lastError` 只反映 refresh 不反映添加失败；refresh 全部源失败仍返回 200。个人自用可接受现状，改进需先定错误分类透出的边界（外部内容不可信，文案需脱敏）。
- **坏条目策略**（中）：任一条目缺 title/正文/稳定 ID 即整源失败（`adapters/news/rss.ts`），连添加都无法完成。是严格策略还是应跳过坏条目属产品取舍。
- **URL 别名去重**（低）：源身份只按规范化 URL 全等，不去 fragment、不归一重定向最终地址；同一 feed 的别名可存多份并产生重复文章/模型开销。
- **failed 重置静默跳过**（低）：手动 refresh 的重置在新闻智能体恰有模型轮运行时直接返回 0 且被忽略，该轮 failed 不重试，无提示。
- **refresh 非法 JSON 被吞**（低）：`routes/news.ts` 将解析失败体当作 `{}` 校验通过并执行刷新；按严格契约应 400。

## 证据与边界

- 源码调查报告（含全部 file:line）由只读执行者产出，主会话对其中 5 组关键断言（阻断表、坏条目、409 双查重、重置跳过、JSON 吞并）逐一 grep 复核一致。
- 真实验收使用临时隔离 DATA_DIR 与 loopback 随机端口；`--allow-private-targets` 仅作用于该隔离实例；未触碰真实实例、共享 12330 或凭据。
- 本轮改动：`tests/live/news.ts` 两处断言修正、`docs/testing.md` 一句同步、本记录与 backlog 状态更新；无业务源码变更。`pnpm check` 结果见交付汇报。
