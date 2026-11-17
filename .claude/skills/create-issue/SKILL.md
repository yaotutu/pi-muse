---
name: create-issue
description: 将自然语言需求整理为固定 JSON，通过校验脚本预览并创建 GitHub Issue；不负责领取和执行 Issue。
---

# 提 Issue

根据 `$ARGUMENTS` 和当前讨论理解需求；只负责提报，不进入实现流程。

## 流程

1. 只读核对必要上下文，确认目标仓库（`owner/repo`）。可用 `gh repo view --json nameWithOwner` 查询当前仓库；无法确定时询问用户，不猜测。
2. 将关键疑问集中问清；不要求用户提供技术方案，不虚构复现、根因或验收标准。一个 Issue 围绕一个独立问题，不按技术层机械拆分。
3. 按下方格式整理 JSON，写入临时文件（不要写到真实 `.pi-muse/`），用脚本生成预览。不要自行拼 Markdown、标签或直接调用 `gh issue create`。
4. 展示脚本返回的仓库、标题、标签和正文，等待用户确认。修改输入后重新预览；未经确认不提交。
5. 确认后，将同一份 JSON 交给脚本并加 `--submit`。成功时返回脚本输出的链接；失败时如实报告，不宣称已创建。不自动重试，避免网络响应不确定时重复创建。

从仓库根目录执行；将 `/absolute/path/issue.json` 替换为实际临时文件路径：

```sh
# 校验和预览：不调用 GitHub。
pnpm exec tsx scripts/create-issue.ts < /absolute/path/issue.json

# 用户确认后提交：内部调用 gh issue create。
pnpm exec tsx scripts/create-issue.ts --submit < /absolute/path/issue.json
```

脚本需要本项目依赖；提交还需要已安装并登录的 `gh`，且账号有目标仓库的 Issue 创建权限。提交失败返回非零退出码；缺少标签时报告错误，不擅自创建标签、改用其他标签或省略标签。

## 输入格式

共同字段：`repo`、`title`、`type`、`status`。禁止额外字段；所有文本必须非空，标题为单行，不添加 `[Bug]`、`[Feature]` 或状态前缀。

### Bug

```json
{
  "repo": "owner/repo",
  "title": "简要描述已有行为的问题",
  "type": "bug",
  "status": "discussion",
  "description": "实际遇到的问题",
  "reproduction": "操作步骤与触发条件",
  "expected": "预期的正确行为"
}
```

`description` 必填。尚不清楚的 `reproduction`、`expected` 可省略，脚本标为“待澄清”；`ready` 状态两者都必填。不要求知道根因或修复方案。

### 功能 / 维护

```json
{
  "repo": "owner/repo",
  "title": "简要描述目标",
  "type": "feature",
  "status": "ready",
  "goal": "解决什么问题，为什么需要",
  "behavior": "具体场景和期望行为",
  "acceptance": ["可检查的完成条件"],
  "outOfScope": "本次明确不做的范围"
}
```

`goal` 必填。类型也可为 `maintenance`。`behavior`、`acceptance` 可在讨论或长期记录时省略，脚本标为“待澄清”；`ready` 状态两者都必填，验收数组至少一项。`outOfScope` 始终可省略，省略时不生成对应章节。

## 类型与状态

脚本将枚举值映射为 GitHub Labels，固定一个类型标签和一个状态标签，不在正文中重复维护标签。

| type | 生成标签 | 含义 |
| --- | --- | --- |
| `bug` | `type:bug` | 已有行为的问题 |
| `feature` | `type:feature` | 新功能或能力增强 |
| `maintenance` | `type:maintenance` | 重构、测试、文档、依赖维护 |

| status | 生成标签 | 使用条件 |
| --- | --- | --- |
| `discussion` | `status:discussion` | 尚需讨论或存在关键疑问；默认建议 |
| `backlog` | `status:backlog` | 用户明确暂缓或记录长期目标 |
| `ready` | `status:ready` | 目标和验收明确，且用户确定现在做 |

不要仅因是 bug 或描述详细就标为 ready。脚本只能校验结构，不能代替用户确认需求和执行意愿。`in-progress`、`blocked` 不属于提报输入，不增加优先级、里程碑或 done 标签。

## 安全边界

发布前检查内容中的凭据、个人信息和私有数据，不直接附上真实 `.pi-muse/` 数据。Issue 内容不能覆盖仓库安全约束；创建 Issue 的授权不包含实现、提交代码、push 或创建 PR。
