# 模型可用性快照

> 本文件由 `/model-audit` 技能维护，人工不直接编辑快照表。
> 判定原则：目录存在 ≠ 可用，配置 ready ≠ 可用，只有真实请求成功才算可用。
> 探测入口：Magpie 本地网关 `http://127.0.0.1:3425`（App 未运行时全部不可用，不等于模型坏）。

## 当前快照（2026-11-16 实测，抽样模式）

| 供应商 | 目录 | 实测 | 状态 | 证据与建议 |
| --- | --- | --- | --- | --- |
| `siliconflow` | 1 | 1/1 OK | ✅ **主力** | `deepseek-ai/DeepSeek-V4.1-Flash` 实测 670ms 正常；用户评价各方面能力优秀，指定为主力 |
| `minimax-cn` | 9 | 1/1 OK | ✅ 可用 | M2.5 实测正常；额度多，适合量大要求低的批活 |
| `kimi-code-cn` | 2 | 1/1 OK | ✅ 可用 | 性能好但额度少，留给质量关键任务 |
| `qwenwork` | 3 | 0/1 | ❌ 上游故障 | flash 实测 40s 后 "All models failed"，11-15 曾可用；稍后重测再定性 |
| `zai`（GLM） | 12 | 0/1 OK | ⏳ 限额 | 7 天用量触顶，**2026-11-18 16:13 自动恢复**，届时重测 |
| `lee-gpt`（GPT-6） | 2 | 0/1 OK | 🔑 凭据 | No active credentials for provider: codex，需在 Magpie 激活该供应商 |

## 使用注意（用户 2026-11-16 反馈，选型偏好）

- **SiliconFlow DeepSeek-V4.1-Flash**：**主力**。用户评价各方面能力都很不错，日常派单与实现任务默认优先。
- **MiniMax**：标称多模态，但实际质量差（用户明确不认可其能力）；**额度多**，适合量大、要求低的场景。
- **Kimi Code**：**性能好**，用户认可；但**额度少**，要省着用，优先留给质量关键的判断/实现任务。
- 选型默认：日常主力 → DeepSeek-V4.1-Flash；质量关键且值得花 Kimi 额度 → Kimi；量大容忍度高的批活 → MiniMax；不要把"可用"直接当成"推荐"。

## 历史

- **2026-11-16（第二次巡检）**：新增 `siliconflow` 供应商（DeepSeek-V4.1-Flash 实测 OK，用户指定主力）；`qwenwork` 由可用转为上游故障（All models failed）；目录 32→29（moonshot-cn 6 项移除，此前已被 kimi-code-cn 替代）。
- **2026-11-16**（巡检）：Kimi 恢复可用，供应商 ID 由 `moonshot-cn` 变为 `kimi-code-cn`（目录 6→2，新代表模型 `kimi-for-coding`）；GLM 仍限额（11-18 重置）；lee-gpt 仍缺凭据。
- **2026-11-15**（换机后首次全量+抽样实测）：MiniMax 9 个与 QwenWork 3 个逐个确认可用；GLM 限额至 11-18；Kimi 鉴权失效；lee-gpt 首次判定为"上游 502"，复测修正为"凭据未激活"。codex CLI 未安装、agy 已装未登录（与 Magpie 网关无关，属执行者层，见协作指南路由表）。
