# 模型可用性快照

> 本文件由 `/model-audit` 技能维护，人工不直接编辑快照表。
> 判定原则：目录存在 ≠ 可用，配置 ready ≠ 可用，只有真实请求成功才算可用。
> 探测入口：Magpie 本地网关 `http://127.0.0.1:3425`（App 未运行时全部不可用，不等于模型坏）。

## 当前快照（2026-11-16 实测，抽样模式）

| 供应商 | 目录 | 实测 | 状态 | 证据与建议 |
| --- | --- | --- | --- | --- |
| `minimax-cn` | 9 | 1/1 OK | ✅ 可用 | M2.5 真实回复正常；产品实例当前即用此家 |
| `qwenwork` | 3 | 1/1 OK | ✅ 可用 | flash 真实回复正常 |
| `kimi-code-cn` | 2 | 1/1 OK | ✅ 可用 | 用户 11-15 重配凭据后恢复；原 `moonshot-cn`（6 模型）入口已被此供应商替代，代表模型 `kimi-for-coding` |
| `zai`（GLM） | 12 | 0/1 OK | ⏳ 限额 | 7 天用量触顶，**2026-11-18 16:13 自动恢复**，届时重测 |
| `lee-gpt`（GPT-6） | 2 | 0/1 OK | 🔑 凭据 | No active credentials for provider: codex，需在 Magpie 激活该供应商 |

当前稳定可用：MiniMax 全系 + QwenWork 全系 + Kimi Code（抽样验证，逐模型以 `--full` 为准）。

## 历史

- **2026-11-16**（巡检）：Kimi 恢复可用，供应商 ID 由 `moonshot-cn` 变为 `kimi-code-cn`（目录 6→2，新代表模型 `kimi-for-coding`）；GLM 仍限额（11-18 重置）；lee-gpt 仍缺凭据。
- **2026-11-15**（换机后首次全量+抽样实测）：MiniMax 9 个与 QwenWork 3 个逐个确认可用；GLM 限额至 11-18；Kimi 鉴权失效；lee-gpt 首次判定为"上游 502"，复测修正为"凭据未激活"。codex CLI 未安装、agy 已装未登录（与 Magpie 网关无关，属执行者层，见协作指南路由表）。
