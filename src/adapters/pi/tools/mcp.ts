import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { McpActiveTool } from "../../../features/mcp/types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type McpToolDetails = {
  server: string;
  tool: string;
  isError?: boolean;
  denied?: boolean;
};

/**
 * 将已连接的外部 MCP 工具装配为 pi ToolDefinition。
 * 按产品原则直接执行，不在 Pi Muse 服务端弹出二次审批；传输错误收敛为受控失败文案。
 */
export const createMcpTools = (activeTools: readonly McpActiveTool[]): ToolDefinition[] =>
  activeTools.map((tool) =>
    defineTool<TSchema, McpToolDetails>({
      name: tool.exposedName,
      label: `${tool.serverName}: ${tool.name}`,
      description: `[MCP: ${tool.serverName}] ${tool.description || tool.name}`,
      parameters: tool.inputSchema as unknown as TSchema,
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        try {
          const result = await tool.execute(isRecord(params) ? params : {}, signal);
          signal?.throwIfAborted();
          return {
            content: result.content,
            details: {
              server: tool.serverName,
              tool: tool.name,
              ...(result.isError ? { isError: true } : {}),
            },
            ...(result.isError ? { isError: true } : {}),
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          return {
            isError: true,
            content: [{ type: "text" as const, text: "MCP tool execution failed." }],
            details: {
              server: tool.serverName,
              tool: tool.name,
              isError: true,
              denied: true,
            },
          };
        }
      },
    }),
  );
