export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const normalizeMcpNamespace = (name: string): string =>
  name.replace(/-/g, "_").toLowerCase();

export type McpTransportKind = "stdio" | "http";

export type McpStdioServerEntry = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  description?: string;
  timeout?: number;
};

export type McpHttpServerEntry = {
  type?: "http";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  description?: string;
  timeout?: number;
};

export type McpServerEntry = McpStdioServerEntry | McpHttpServerEntry;

export type McpConfigDocument = {
  mcpServers: Record<string, McpServerEntry>;
};

export type McpConnectionStatus =
  | "disabled"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type McpToolSummary = {
  name: string;
  exposedName: string;
  description: string;
};

export type McpToolDescriptor = McpToolSummary & {
  inputSchema: Record<string, unknown>;
};

export type McpToolCallContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type McpToolCallOutput = {
  content: McpToolCallContentPart[];
  isError?: boolean;
};

/** 暴露给客户端的脱敏视图：不返回任何 env 或 headers 明文值。 */
export type McpServerView = {
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  description: string;
  timeout: number;
  status: McpConnectionStatus;
  error: string | null;
  connectedAt: string | null;
  toolCount: number;
  tools: McpToolSummary[];
  command: string | null;
  args: string[];
  cwd: string | null;
  envKeys: string[];
  url: string | null;
  headerNames: string[];
};

export type McpDiagnostic = {
  server: string;
  message: string;
};

export type McpListResponse = {
  servers: McpServerView[];
  diagnostics: McpDiagnostic[];
};

export type McpActiveTool = {
  serverName: string;
  name: string;
  exposedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<McpToolCallOutput>;
};

export type McpPromptSummary = {
  name: string;
  summary: string;
  toolCount: number;
};

export type McpServerPatch = {
  enabled?: boolean;
  description?: string;
  timeout?: number;
};

export type McpAssistantOverridesRepository = {
  load: () => Promise<Record<string, boolean>>;
  save: (overrides: Record<string, boolean>) => Promise<void>;
};

export type McpSubagentOverridesRepository = {
  load: () => Promise<Record<string, string[]>>;
  save: (subagents: Record<string, string[]>) => Promise<void>;
};

export type McpAssistantServerView = {
  name: string;
  transport: McpTransportKind;
  description: string;
  globalEnabled: boolean;
  status: McpConnectionStatus;
  toolCount: number;
  defaultEnabled: true;
  enabled: boolean;
  effectiveEnabled: boolean;
};

export type McpAssistantSelectionResponse = {
  servers: McpAssistantServerView[];
  overrides: Record<string, boolean>;
};

export type McpSubagentServerView = {
  name: string;
  transport: McpTransportKind;
  description: string;
  globalEnabled: boolean;
  status: McpConnectionStatus;
  toolCount: number;
  defaultEnabled: false;
  enabled: boolean;
  effectiveEnabled: boolean;
};

export type McpSubagentSelectionResponse = {
  subagentId: string;
  servers: McpSubagentServerView[];
  enabledServers: string[];
};

export type McpToolFilterOptions = {
  scope?: "assistant" | "all";
  allowedServers?: ReadonlySet<string>;
};

export type McpErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CONFIG_CORRUPT"
  | "CONNECTION_FAILED";

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly status: 400 | 404 | 409 | 500 | 502;

  constructor(code: McpErrorCode, message: string, status: 400 | 404 | 409 | 500 | 502) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.status = status;
  }
}

export type McpRepository = {
  load: () => Promise<{ document: McpConfigDocument; diagnostics: McpDiagnostic[]; corrupt?: boolean }>;
  save: (document: McpConfigDocument) => Promise<void>;
};

export type McpRuntimeConnection = {
  summary: string;
  tools: readonly McpToolDescriptor[];
  callTool: (
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<McpToolCallOutput>;
  close: () => Promise<void>;
};

export type McpTransportConnector = {
  connect: (
    name: string,
    entry: McpServerEntry,
    options: {
      isToolNameTaken: (exposedName: string) => boolean;
      onUnexpectedClose: () => void;
    },
  ) => Promise<McpRuntimeConnection>;
};

export type McpService = {
  start: () => Promise<void>;
  list: () => Promise<McpListResponse>;
  get: (name: string) => Promise<McpServerView>;
  upsert: (name: string, entry: unknown) => Promise<McpServerView>;
  patch: (name: string, patch: McpServerPatch) => Promise<McpServerView>;
  remove: (name: string) => Promise<{ ok: true; name: string }>;
  reconnect: (name: string) => Promise<McpServerView>;
  describeAssistantSelection: () => Promise<McpAssistantSelectionResponse>;
  updateAssistantOverrides: (overrides: Record<string, boolean>) => Promise<McpAssistantSelectionResponse>;
  describeSubagentSelection: (subagentId: string) => Promise<McpSubagentSelectionResponse>;
  updateSubagentServers: (subagentId: string, servers: readonly string[]) => Promise<McpSubagentSelectionResponse>;
  getSubagentAllowedServers: (subagentId: string) => Promise<ReadonlySet<string>>;
  getActiveTools: (options?: McpToolFilterOptions) => Promise<readonly McpActiveTool[]>;
  getPromptSummaries: (options?: McpToolFilterOptions) => readonly McpPromptSummary[];
  close: () => Promise<void>;
};
