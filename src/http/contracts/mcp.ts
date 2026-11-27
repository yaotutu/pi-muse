import { z } from "zod";
import { MCP_SERVER_NAME_PATTERN } from "../../features/mcp/types.js";
import { errorResponse } from "./responses.js";

export { MCP_SERVER_NAME_PATTERN };

export const mcpToolSummarySchema = z.strictObject({
  name: z.string().min(1).describe("MCP 服务端声明的原始工具名"),
  exposedName: z.string().min(1).describe("暴露给模型的工具名（mcp__<server>__<tool>）"),
  description: z.string().describe("工具说明"),
});

export const mcpServerViewSchema = z.strictObject({
  name: z.string().regex(MCP_SERVER_NAME_PATTERN).describe("MCP 服务唯一名称"),
  transport: z.enum(["stdio", "http"]).describe("传输方式：stdio 本地子进程或 http（Streamable HTTP）"),
  enabled: z.boolean().describe("是否启用该服务"),
  description: z.string().describe("服务说明"),
  timeout: z.number().int().min(1).max(600).describe("单次请求超时时间（秒）"),
  status: z.enum(["disabled", "disconnected", "connecting", "connected", "error"]).describe("当前连接状态"),
  error: z.string().nullable().describe("脱敏后的连接错误摘要；正常时为 null"),
  connectedAt: z.iso.datetime().nullable().describe("最近一次成功连接时间（ISO 8601 UTC）"),
  toolCount: z.number().int().nonnegative().describe("已发现工具数量"),
  tools: z.array(mcpToolSummarySchema).describe("当前连接暴露的工具清单"),
  command: z.string().nullable().describe("stdio 可执行命令；http 服务为 null"),
  args: z.array(z.string()).describe("stdio 命令行参数列表"),
  cwd: z.string().nullable().describe("stdio 工作目录；未配置或 http 服务为 null"),
  envKeys: z.array(z.string()).describe("仅返回已配置的环境变量键名，不回传明文值"),
  url: z.string().nullable().describe("Streamable HTTP 端点 URL；stdio 服务为 null"),
  headerNames: z.array(z.string()).describe("仅返回已配置的自定义请求头名称，不回传明文值"),
});

export const mcpDiagnosticSchema = z.strictObject({
  server: z.string().describe("关联的 MCP 服务名或配置文件名"),
  message: z.string().describe("可读配置诊断信息"),
});

export const mcpListResponseSchema = z.strictObject({
  servers: z.array(mcpServerViewSchema).describe("已配置的所有 MCP 服务列表（按名称排序，凭据已脱敏）"),
  diagnostics: z.array(mcpDiagnosticSchema).describe("加载 mcp.json 时的配置诊断列表"),
});

export const mcpServerResponseSchema = z.strictObject({
  server: mcpServerViewSchema,
});

export const mcpDeleteResponseSchema = z.strictObject({
  ok: z.literal(true),
  name: z.string().regex(MCP_SERVER_NAME_PATTERN),
});

export const mcpServerUpsertRequest = z.strictObject({
  type: z.enum(["stdio", "http", "streamable-http"]).optional().describe("可选传输类型，默认按 command/url 自动推断"),
  command: z.string().min(1).max(512).optional().describe("stdio 模式可执行命令（与 url 二选一）"),
  args: z.array(z.string()).max(64).optional().describe("stdio 模式参数列表"),
  env: z.record(z.string(), z.string()).optional().describe("stdio 模式环境变量键值表（服务端仅持久化保存，接口回读不返回明文值）"),
  cwd: z.string().max(512).optional().describe("stdio 模式工作目录，相对路径基于 workspace/ 解析"),
  url: z.string().min(1).max(2048).optional().describe("http（Streamable HTTP）模式端点 URL（与 command 二选一，不能带 URL 凭据）"),
  headers: z.record(z.string(), z.string()).optional().describe("http 模式自定义请求头（服务端仅持久化保存，接口回读不返回明文值）"),
  enabled: z.boolean().optional().describe("是否启用，默认 true"),
  description: z.string().max(300).optional().describe("服务用途说明，用于系统提示词摘要"),
  timeout: z.number().int().min(1).max(600).optional().describe("单次请求超时时间（秒），默认 60，上限 600"),
}).refine(
  (data) => Boolean(data.command?.trim()) !== Boolean(data.url?.trim()),
  { message: "Specify either command or url, not both" },
);

export const mcpServerPatchRequest = z.strictObject({
  enabled: z.boolean().optional().describe("启用或禁用服务"),
  description: z.string().max(300).optional().describe("更新服务用途说明"),
  timeout: z.number().int().min(1).max(600).optional().describe("更新单次请求超时时间（秒）"),
});

export const mcpAssistantServerViewSchema = z.strictObject({
  name: z.string().regex(MCP_SERVER_NAME_PATTERN).describe("MCP 服务唯一名称"),
  transport: z.enum(["stdio", "http"]).describe("传输方式"),
  description: z.string().describe("服务说明"),
  globalEnabled: z.boolean().describe("全局总开关是否启用"),
  status: z.enum(["disabled", "disconnected", "connecting", "connected", "error"]).describe("全局连接状态"),
  toolCount: z.number().int().nonnegative().describe("工具数量"),
  defaultEnabled: z.literal(true).describe("主聊天对全局已声明服务的默认状态（默认开启）"),
  enabled: z.boolean().describe("主聊天对该服务的独立选用开关"),
  effectiveEnabled: z.boolean().describe("主聊天当前最终是否可用（globalEnabled && enabled）"),
});

export const mcpAssistantSelectionResponseSchema = z.strictObject({
  servers: z.array(mcpAssistantServerViewSchema).describe("全局列表在主聊天视角下的选用清单"),
  overrides: z.record(z.string(), z.boolean()).describe("已保存的主聊天显式覆盖开关映射"),
});

export const mcpAssistantOverridesRequest = z.strictObject({
  overrides: z.record(z.string(), z.boolean()).describe("主聊天 MCP 独立选用覆盖映射；未列出的全局服务默认开启"),
});

export const mcpErrorResponses = {
  400: { description: "服务名称或配置参数不合法", schema: errorResponse },
  404: { description: "指定名称的 MCP 服务不存在", schema: errorResponse },
  409: { description: "服务名与现有服务在归一化命名空间上冲突", schema: errorResponse },
  500: { description: "DATA_DIR/mcp.json 损坏或不是安全的常规文件", schema: errorResponse },
} as const;
