import { lstat, readFile } from "node:fs/promises";
import { McpError, MCP_SERVER_NAME_PATTERN, normalizeMcpNamespace, type McpAssistantOverridesRepository, type McpConfigDocument, type McpDiagnostic, type McpRepository, type McpServerEntry, type McpSubagentOverridesRepository } from "../../features/mcp/types.js";
import type { DataLayout } from "./data-layout.js";
import { writeJsonDocument } from "./json-document.js";

const SUBAGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === "string");

const normalizeRawEntry = (name: string, raw: unknown): McpServerEntry | string => {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return "Invalid server name; use letters, digits, _ or -";
  }
  if (!isRecord(raw)) return "Server entry must be an object";

  const rawType = raw.type;
  if (rawType !== undefined && rawType !== "stdio" && rawType !== "http" && rawType !== "streamable-http") {
    return `Unsupported transport type: ${String(rawType)}`;
  }

  const enabled = raw.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") return "enabled must be a boolean";
  const description = raw.description;
  if (description !== undefined && typeof description !== "string") return "description must be a string";
  const timeout = raw.timeout;
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 600)) {
    return "timeout must be an integer between 1 and 600";
  }

  const hasCommand = typeof raw.command === "string" && raw.command.trim().length > 0;
  const hasUrl = typeof raw.url === "string" && raw.url.trim().length > 0;
  if (hasCommand && hasUrl) return "Specify either command or url, not both";
  if (!hasCommand && !hasUrl) return "Must specify either command (stdio) or url (http)";

  if (hasCommand) {
    if (rawType === "http" || rawType === "streamable-http") {
      return "type=http cannot be used with command";
    }
    if (raw.args !== undefined && !isStringArray(raw.args)) return "args must be an array of strings";
    if (raw.env !== undefined && !isStringRecord(raw.env)) return "env must be a string map";
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") return "cwd must be a string";
    return {
      type: "stdio",
      command: (raw.command as string).trim(),
      ...(raw.args ? { args: [...raw.args] } : {}),
      ...(raw.env ? { env: { ...raw.env } } : {}),
      ...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(typeof description === "string" ? { description } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  if (rawType === "stdio") return "type=stdio cannot be used with url";
  let parsed: URL;
  try {
    parsed = new URL((raw.url as string).trim());
  } catch {
    return "url must be a valid HTTP(S) URL";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return "url must use http or https";
  if (parsed.username || parsed.password) return "url must not contain embedded credentials";
  if (raw.headers !== undefined && !isStringRecord(raw.headers)) return "headers must be a string map";

  return {
    type: "http",
    url: parsed.toString(),
    ...(raw.headers ? { headers: { ...raw.headers } } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
};

const ensureNotSymlink = async (file: string) => {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new McpError("CONFIG_CORRUPT", "MCP config file must be a regular file", 500);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof McpError) throw error;
    throw new McpError("CONFIG_CORRUPT", "Unable to inspect MCP config file", 500);
  }
  return true;
};

/**
 * 托管 DATA_DIR/mcp.json：兼容社区标准 `{ "mcpServers": { ... } }` 写法，
 * 拒绝符号链接，单条非法条目只记入 diagnostics 而不拖垮其余有效服务。
 */
export const createMcpRepository = (layout: Pick<DataLayout, "mcpConfigFile">): McpRepository => {
  const file = layout.mcpConfigFile;
  return {
    load: async () => {
      const exists = await ensureNotSymlink(file);
      if (!exists) return { document: { mcpServers: {} }, diagnostics: [] };

      let rawText: string;
      try {
        rawText = await readFile(file, "utf8");
      } catch {
        return {
          document: { mcpServers: {} },
          diagnostics: [{ server: "mcp.json", message: "Failed to read mcp.json" }],
          corrupt: true,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return {
          document: { mcpServers: {} },
          diagnostics: [{ server: "mcp.json", message: "Invalid JSON in mcp.json" }],
          corrupt: true,
        };
      }

      if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
        return {
          document: { mcpServers: {} },
          diagnostics: [{ server: "mcp.json", message: "mcp.json must contain an mcpServers object" }],
          corrupt: true,
        };
      }

      const mcpServers: Record<string, McpServerEntry> = {};
      const diagnostics: McpDiagnostic[] = [];
      const seenNamespaces = new Map<string, string>();

      for (const [name, rawEntry] of Object.entries(parsed.mcpServers)) {
        const normalized = normalizeRawEntry(name, rawEntry);
        if (typeof normalized === "string") {
          diagnostics.push({ server: name, message: normalized });
          continue;
        }
        const ns = normalizeMcpNamespace(name);
        const existingOwner = seenNamespaces.get(ns);
        if (existingOwner) {
          diagnostics.push({
            server: name,
            message: `Server namespace collides with "${existingOwner}"`,
          });
          continue;
        }
        seenNamespaces.set(ns, name);
        mcpServers[name] = normalized;
      }

      return { document: { mcpServers }, diagnostics };
    },
    save: async (document: McpConfigDocument) => {
      await ensureNotSymlink(file);
      await writeJsonDocument(file, { mcpServers: document.mcpServers });
    },
  };
};

/** 持久化主聊天的独立 MCP 选用开关；默认开启全局已启用服务，只保存显式覆盖记录。 */
export const createMcpAssistantOverridesRepository = (
  layout: Pick<DataLayout, "assistantMcpOverridesFile">,
): McpAssistantOverridesRepository => {
  const file = layout.assistantMcpOverridesFile;
  return {
    load: async () => {
      const exists = await ensureNotSymlink(file);
      if (!exists) return {};
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        throw new McpError("CONFIG_CORRUPT", "Failed to read assistant MCP overrides", 500);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new McpError("CONFIG_CORRUPT", "Invalid JSON in assistant MCP overrides", 500);
      }
      if (!isRecord(parsed) || !isRecord(parsed.overrides)) {
        throw new McpError("CONFIG_CORRUPT", "Assistant MCP overrides must contain an overrides object", 500);
      }
      const overrides: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed.overrides)) {
        if (!MCP_SERVER_NAME_PATTERN.test(k) || typeof v !== "boolean") {
          throw new McpError("CONFIG_CORRUPT", "Invalid assistant MCP override entry", 500);
        }
        overrides[k] = v;
      }
      return overrides;
    },
    save: async (overrides: Record<string, boolean>) => {
      await ensureNotSymlink(file);
      await writeJsonDocument(file, { overrides });
    },
  };
};

/** 持久化各专职 Subagent 的独立 MCP 白名单；默认全部关闭，仅显式选中的全局服务才会注入对应 Subagent。 */
export const createSubagentMcpOverridesRepository = (
  layout: Pick<DataLayout, "subagentMcpOverridesFile">,
): McpSubagentOverridesRepository => {
  const file = layout.subagentMcpOverridesFile;
  return {
    load: async () => {
      const exists = await ensureNotSymlink(file);
      if (!exists) return {};
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        throw new McpError("CONFIG_CORRUPT", "Failed to read subagent MCP overrides", 500);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new McpError("CONFIG_CORRUPT", "Invalid JSON in subagent MCP overrides", 500);
      }
      if (!isRecord(parsed) || !isRecord(parsed.subagents)) {
        throw new McpError("CONFIG_CORRUPT", "Subagent MCP overrides must contain a subagents object", 500);
      }
      const subagents: Record<string, string[]> = {};
      for (const [subagentId, list] of Object.entries(parsed.subagents)) {
        if (!SUBAGENT_ID_PATTERN.test(subagentId) || !isStringArray(list)) {
          throw new McpError("CONFIG_CORRUPT", "Invalid subagent MCP override entry", 500);
        }
        const unique = new Set<string>();
        for (const name of list) {
          if (!MCP_SERVER_NAME_PATTERN.test(name)) {
            throw new McpError("CONFIG_CORRUPT", "Invalid MCP server name in subagent overrides", 500);
          }
          unique.add(name);
        }
        if (unique.size > 0) {
          subagents[subagentId] = [...unique].sort((a, b) => a.localeCompare(b));
        }
      }
      return subagents;
    },
    save: async (subagents: Record<string, string[]>) => {
      await ensureNotSymlink(file);
      await writeJsonDocument(file, { subagents });
    },
  };
};
