import { z } from "zod";
import { MCP_SERVER_NAME_PATTERN } from "../../features/mcp/types.js";
import { SUBAGENT_ID_PATTERN } from "../../features/subagents/types.js";
import { habitItemSchema } from "./habits.js";
import { workspaceIncludeDiagnosticSchema } from "./workspace-includes.js";

export const subagentIdParamSchema = z
  .string()
  .regex(SUBAGENT_ID_PATTERN, "id must match [a-z][a-z0-9_-]{0,63}");

export const subagentTriggerSchema = z.enum(["chat", "background"]);

export const subagentPromptSectionSchema = z.strictObject({
  key: z.string().min(1).describe("提示词片段标识（如 chat、realtime、archive、screening、consolidate）"),
  label: z.string().min(1).describe("提示词展示标题"),
  trigger: subagentTriggerSchema.describe("适用的触发模式（chat=主聊天路由；background=后台定时/事件触发）"),
  source: z.enum(["builtin", "workspace"]).describe("提示词来源（builtin=仓库内置静态提示词；workspace=工作区用户文档）"),
  sourcePath: z.string().min(1).describe("提示词来源相对路径"),
  editable: z.boolean().describe("当前是否允许直接编辑"),
  content: z.string().describe("提示词原文"),
});

export const subagentToolSpecSchema = z.strictObject({
  name: z.string().min(1).describe("绑定工具名称"),
  description: z.string().min(1).describe("工具职责说明"),
  triggers: z.array(subagentTriggerSchema).min(1).describe("该工具生效的触发模式"),
  requiresApproval: z.boolean().optional().describe("写操作是否经版本绑定人工审批"),
});

export const subagentSkillSpecSchema = z.strictObject({
  name: z.string().min(1).describe("绑定的技能名称"),
  description: z.string().min(1).describe("技能说明"),
});

export const subagentMcpSpecSchema = z.strictObject({
  name: z.string().min(1).describe("绑定的 MCP 服务器名称"),
  description: z.string().optional().describe("MCP 能力说明"),
  transport: z.string().optional().describe("MCP 传输方式"),
});

export const subagentExecutionPolicySchema = z.strictObject({
  stateless: z.literal(true).describe("恒为 true：纯函数语义，无跨次聊天历史，仅单次执行周期内持有独立内存会话"),
  parallelAllowed: z.boolean().describe("是否允许在 parallel 并发模式中运行（独占资源如 browser 为 false）"),
});

export const subagentEditabilitySchema = z.strictObject({
  enabled: z.enum(["editable", "readonly"]).describe("统一启停状态可编辑性（editable=可随时开启/停用；readonly=底层能力不可用）"),
  systemPrompts: z.literal("readonly").describe("内置系统提示词当前只读"),
  userInstructions: z.enum(["editable", "none"]).describe("关联用户指令文件的可编辑状态（editable 可经领域偏好或工作区文件接口修改；none 表示无关联用户指令文件）"),
  tools: z.literal("readonly").describe("静态绑定工具列表当前只读"),
  skills: z.literal("readonly").describe("静态绑定技能列表当前只读"),
  mcp: z.enum(["editable", "readonly"]).describe("外部 MCP 服务权限状态（editable=可从全局目录按需选用；readonly=仅后台结构化任务，不支持绑定 MCP）"),
});

export const subagentUpdateRequestSchema = z.strictObject({
  enabled: z.boolean().describe("统一控制该 Subagent 是否启用（同时作用于对话路由与后台自动运行）"),
});

export const subagentInstructionsSnapshotSchema = z.strictObject({
  path: z.string().min(1).describe("关联用户指令在工作区内的相对路径（如 subagents/sms/AGENTS.md）"),
  instructions: z.string().describe("用户指令原文（保留顶部 YAML Frontmatter include: 引用）"),
  includes: z.array(workspaceIncludeDiagnosticSchema).optional().describe("顶部 YAML Frontmatter include: 引用展开诊断"),
  habits: z.array(habitItemSchema).describe("当前关联领域已归纳及手动维护的行为习惯"),
  unconsolidatedFeedbackCount: z.number().int().nonnegative().optional().describe("尚未归纳的活跃反馈计数"),
});

export const subagentSummarySchema = z.strictObject({
  id: subagentIdParamSchema.describe("Subagent 唯一标识（如 sms、browser、habits、dream）"),
  name: z.string().min(1).describe("Subagent 展示名称"),
  description: z.string().min(1).describe("Subagent 职责与能力声明"),
  routingHint: z.string().nullable().describe("由该 Subagent 自己维护并注入主聊天提示词的路由注意事项；无则为 null"),
  triggers: z.array(subagentTriggerSchema).min(1).describe("支持的触发入口（chat=可由主聊天路由调用；background=由后台任务/事件触发）"),
  enabled: z.boolean().describe("当前是否处于启用可用状态"),
  executionPolicy: subagentExecutionPolicySchema.describe("执行策略（纯函数无跨次上下文、是否允许并发）"),
  hasUserInstructions: z.boolean().describe("是否关联可编辑的用户领域指令文件"),
  capabilities: z.strictObject({
    tools: z.array(subagentToolSpecSchema).describe("该 Subagent 静态绑定的全部工具清单"),
    skills: z.array(subagentSkillSpecSchema).describe("该 Subagent 静态绑定的技能清单"),
    mcp: z.array(subagentMcpSpecSchema).describe("该 Subagent 显式选用的全局 MCP 服务清单"),
  }).describe("静态绑定的能力清单"),
  editability: subagentEditabilitySchema.describe("各配置维度当前的可编辑性元信息"),
});

export const subagentsListResponseSchema = z.strictObject({
  subagents: z.array(subagentSummarySchema).describe("服务端已注册的全部专职 Subagent 列表"),
});

export const subagentDetailResponseSchema = subagentSummarySchema.extend({
  prompts: z.array(subagentPromptSectionSchema).describe("该 Subagent 绑定的全部内置系统提示词原文与来源"),
  userInstructions: subagentInstructionsSnapshotSchema.nullable().describe("关联的用户指令、include 诊断与行为习惯快照；无关联文件时为 null"),
});

export const subagentMcpServerViewSchema = z.strictObject({
  name: z.string().regex(MCP_SERVER_NAME_PATTERN).describe("全局 MCP 服务名称"),
  transport: z.enum(["stdio", "http"]).describe("传输方式"),
  description: z.string().describe("服务说明"),
  globalEnabled: z.boolean().describe("全局总开关是否启用"),
  status: z.enum(["disabled", "disconnected", "connecting", "connected", "error"]).describe("全局连接状态"),
  toolCount: z.number().int().nonnegative().describe("工具数量"),
  defaultEnabled: z.literal(false).describe("专职 Subagent 对全局 MCP 服务的默认状态（默认关闭）"),
  enabled: z.boolean().describe("当前 Subagent 是否已启用该 MCP 服务"),
  effectiveEnabled: z.boolean().describe("最终是否生效（globalEnabled && enabled）"),
});

export const subagentMcpSelectionResponseSchema = z.strictObject({
  subagentId: subagentIdParamSchema.describe("目标 Subagent ID"),
  editable: z.boolean().describe("当前 Subagent 是否支持自定义选用全局 MCP 服务"),
  servers: z.array(subagentMcpServerViewSchema).describe("全部全局 MCP 服务在该 Subagent 视角下的选用清单"),
  enabledServers: z.array(z.string().regex(MCP_SERVER_NAME_PATTERN)).describe("当前为该 Subagent 启用的 MCP 服务名列表"),
});

export const subagentMcpUpdateRequestSchema = z.strictObject({
  servers: z.array(z.string().regex(MCP_SERVER_NAME_PATTERN)).max(64).describe("允许该 Subagent 使用的全局 MCP 服务名称清单"),
});
