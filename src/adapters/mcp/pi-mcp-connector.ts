import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  createMcpToolName,
  limitMcpContent,
  mcpServerSummary,
  normalizeMcpInputSchema,
  toMcpModelContent,
} from "@earendil-works/pi-mcp";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  McpRuntimeConnection,
  McpServerEntry,
  McpToolDescriptor,
  McpTransportConnector,
} from "../../features/mcp/types.js";

const DEFAULT_TIMEOUT_MS = 60_000;

const resolveCwd = (workspaceDir: string, rawCwd?: string): string => {
  if (!rawCwd) return workspaceDir;
  if (rawCwd === "~") return homedir();
  if (rawCwd.startsWith("~/")) return resolve(homedir(), rawCwd.slice(2));
  return resolve(workspaceDir, rawCwd);
};

/**
 * 复用 @earendil-works/pi-mcp 的标准 stdio 与 Streamable HTTP 客户端传输实现。
 * 保持连接异常与意外断开向服务层通知，工具名映射遵循 mcp__<server>__<tool> 约定。
 */
export const createPiMcpConnector = (deps: {
  workspaceDir: string;
  version: string;
}): McpTransportConnector => ({
  connect: async (name, entry: McpServerEntry, { isToolNameTaken, onUnexpectedClose }) => {
    const timeoutMs = (entry.timeout ?? 60) * 1000 || DEFAULT_TIMEOUT_MS;
    const client = new McpClient({
      name: "pi-muse",
      version: deps.version,
      requestTimeoutMs: timeoutMs,
    });

    const transport = "command" in entry
      ? new StdioTransport({
          command: entry.command,
          args: entry.args,
          cwd: resolveCwd(deps.workspaceDir, entry.cwd),
          env: entry.env,
          inheritEnv: true,
          stderr: "pipe",
          closeTimeoutMs: 2_000,
        })
      : new StreamableHttpTransport({
          url: entry.url,
          headers: entry.headers,
          openGetStream: true,
        });

    let closingExplicitly = false;
    client.onError(() => {
      // 错误详情由 connect / callTool 返回或在断开事件时转为受控状态，避免未捕获异常。
    });
    client.onClose(() => {
      if (!closingExplicitly) onUnexpectedClose();
    });

    try {
      await client.connect(transport);
      const rawTools = await client.listTools({ timeoutMs });
      const usedInServer = new Set<string>();
      const tools: McpToolDescriptor[] = rawTools.map((tool) => {
        const exposedName = createMcpToolName(
          name,
          tool.name,
          (candidate) => usedInServer.has(candidate) || isToolNameTaken(candidate),
        );
        usedInServer.add(exposedName);
        return {
          name: tool.name,
          exposedName,
          description: tool.description?.trim() ?? "",
          inputSchema: normalizeMcpInputSchema((tool.inputSchema ?? {}) as Record<string, unknown>),
        };
      });

      const summary = mcpServerSummary(entry.description, client.instructions);

      const connection: McpRuntimeConnection = {
        summary,
        tools,
        callTool: async (toolName, args, signal) => {
          signal?.throwIfAborted();
          const result = await client.callTool(toolName, args, {
            signal,
            timeoutMs,
          });
          signal?.throwIfAborted();
          const modelContent = await toMcpModelContent(name, result);
          const limited = await limitMcpContent(modelContent);
          return {
            content: limited.content,
            ...(result.isError ? { isError: true } : {}),
          };
        },
        close: async () => {
          closingExplicitly = true;
          await client.close().catch(() => undefined);
        },
      };
      return connection;
    } catch (error) {
      closingExplicitly = true;
      await client.close().catch(() => undefined);
      throw error;
    }
  },
});
