import { defineTool, type AgentSessionEvent, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  SUBAGENT_INSTRUCTIONS_MAX_LENGTH,
  type SubagentChatRunContext,
  type SubagentChatRunResult,
  type SubagentPromptSection,
  type SubagentRegistration,
} from "../../../features/subagents/types.js";
import type { BrowserService } from "../../../features/browser/browser-service.js";
import type { InformationService } from "../../../features/information/service.js";
import { InformationError } from "../../../features/information/errors.js";
import type { McpService } from "../../../features/mcp/types.js";
import { loadPrompt } from "../../prompts/loader.js";
import { managedWorkspaceTexts } from "../../workspace/managed-text.js";
import { runSubagent, type SubagentRuntimeDeps } from "../subagent-runner.js";
import { currentTimeTool } from "../tools/current-time.js";
import { createBrowserTools } from "../tools/browser.js";
import { createFileTools } from "../tools/files.js";
import { createMcpTools } from "../tools/mcp.js";
import { SUBMIT_INFORMATION_BRIEFING_TOOL_NAME, SUBMIT_INFORMATION_RESULT_TOOL_NAME } from "../information-runner.js";
import { PROPOSE_NOTES_TOOL_NAME } from "../dream-runner.js";

export type BuiltinSubagentsDeps = SubagentRuntimeDeps & {
  information: Pick<InformationService, "getPreferences" | "query">;
  browser?: BrowserService;
  mcp?: Pick<McpService, "getSubagentAllowedServers" | "getActiveTools" | "getPromptSummaries">;
  onSmsEnabledChanged?: (enabled: boolean) => Promise<void> | void;
};

type DomainQueryInput = {
  action: "overview" | "items" | "item" | "runs" | "run";
  status?: string;
  limit?: number;
  cursor?: string;
  itemId?: string;
  runId?: string;
};

const queryParameters = Type.Object(
  {
    action: Type.Union([
      Type.Literal("overview"),
      Type.Literal("items"),
      Type.Literal("item"),
      Type.Literal("runs"),
      Type.Literal("run"),
    ]),
    status: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
    cursor: Type.Optional(Type.String()),
    itemId: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const updateInstructionsParameters = Type.Object(
  {
    instructions: Type.String({
      description: "Complete merged explicit user instructions text (preserving YAML frontmatter include: unless asked to modify it).",
    }),
    reason: Type.Optional(Type.String({ description: "Brief explanation for why the instructions are being updated." })),
  },
  { additionalProperties: false },
);

const rejected = (text: string): AgentToolResult<{ denied: true }> => ({
  content: [{ type: "text", text }],
  details: { denied: true },
  isError: true,
});

const runStatelessChatSubagent = async (
  deps: BuiltinSubagentsDeps,
  options: {
    id: string;
    systemPrompt: string;
    tools: readonly ToolDefinition[];
    task: string;
    ctx: SubagentChatRunContext;
  },
): Promise<SubagentChatRunResult> => {
  const { ctx } = options;
  let systemPrompt = options.systemPrompt;
  const tools = [...options.tools];
  if (deps.mcp) {
    const allowedServers = await deps.mcp.getSubagentAllowedServers(options.id);
    if (allowedServers.size > 0) {
      const usedNames = new Set(tools.map((tool) => tool.name));
      const activeMcpTools = (await deps.mcp.getActiveTools({ allowedServers }))
        .filter((tool) => !usedNames.has(tool.exposedName));
      if (activeMcpTools.length > 0) {
        tools.push(...createMcpTools(activeMcpTools));
      }
      const summaries = deps.mcp.getPromptSummaries({ allowedServers });
      if (summaries.length > 0) {
        const list = summaries.map((s) => `- ${s.name} (${s.toolCount} tools): ${s.summary}`).join("\n");
        systemPrompt = `${systemPrompt}\n\n${loadPrompt("assistant/tools/mcp.md").replace("{{MCP_SERVERS}}", list).trim()}`;
      }
    }
  }
  const run = await runSubagent(deps, {
    cwd: deps.layout.workspaceDir,
    systemPrompt,
    prompt: `Task: ${options.task}`,
    tools,
    compaction: true,
    timeoutMs: null,
    signal: ctx.signal,
    trace: {
      sessionId: ctx.sessionId,
      kind: "subagent",
      extra: { parentSessionId: ctx.sessionId, role: options.id },
    },
    subscribers: ctx.subscribers as readonly ((event: AgentSessionEvent) => void)[] | undefined,
    onEvent: (event) => {
      if (event.type === "tool_execution_start" || event.type === "message_end") {
        ctx.onProgress?.(`Subagent ${options.id} is working`);
      }
    },
  });

  if (!run.ok && run.error === "CANCELLED") {
    ctx.signal?.throwIfAborted();
    return { agent: options.id, task: options.task, output: "Subagent execution failed", isError: true };
  }
  const failed = !run.ok;
  return {
    agent: options.id,
    task: options.task,
    output: failed ? "Subagent execution failed" : run.text || "(no output)",
    isError: failed,
  };
};

const createDomainChatTools = (options: {
  prefix: "sms";
  instructionsPath: string;
  readPreferences: () => Promise<{
    instructions: string;
    includes?: unknown[];
    habits: unknown[];
    unconsolidatedFeedbackCount?: number;
  }>;
  query: (input: DomainQueryInput) => Promise<Record<string, unknown>>;
  ctx: SubagentChatRunContext;
}): ToolDefinition[] => {
  const { prefix, instructionsPath, readPreferences, query, ctx } = options;

  const queryTool = defineTool({
    name: `${prefix}_query`,
    label: `${prefix.toUpperCase()} Query`,
    description: `Read-only inspection of ${prefix} overview, items/articles, single item, or processing runs.`,
    parameters: queryParameters,
    execute: async (_toolCallId, params) => {
      try {
        const limit = params.limit === undefined ? undefined : Math.floor(params.limit);
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
          return rejected("limit must be an integer from 1 to 100.");
        }
        const result = await query({
          ...params,
          ...(limit !== undefined ? { limit } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } catch (error) {
        if (error instanceof InformationError && error.code !== "SHUTDOWN") {
          return rejected(error.message);
        }
        throw error;
      }
    },
  });

  const getInstructionsTool = defineTool({
    name: `${prefix}_get_instructions`,
    label: `${prefix.toUpperCase()} Get Instructions`,
    description: `Read current explicit user instructions (${instructionsPath}), include diagnostics, consolidated habits, and unconsolidated feedback count.`,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const snapshot = await readPreferences();
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot) }],
        details: snapshot,
      };
    },
  });

  const updateInstructionsTool = defineTool({
    name: `${prefix}_update_instructions`,
    label: `${prefix.toUpperCase()} Update Instructions`,
    description: `Save complete merged user instructions directly to ${instructionsPath}.`,
    parameters: updateInstructionsParameters,
    execute: async (toolCallId, params, signal, _onUpdate, toolContext) => {
      if (typeof params.instructions !== "string" || params.instructions.length > SUBAGENT_INSTRUCTIONS_MAX_LENGTH) {
        return rejected(`instructions must be a string of at most ${SUBAGENT_INSTRUCTIONS_MAX_LENGTH} characters`);
      }
      if (!ctx.writeWorkspaceFile) {
        return rejected("Workspace instruction writing is unavailable.");
      }
      signal?.throwIfAborted();
      const current = await readPreferences();
      signal?.throwIfAborted();
      if (current.instructions === params.instructions) {
        return {
          content: [{ type: "text", text: "Domain instructions are unchanged." }],
          details: { updated: false },
        };
      }
      const saved = await ctx.writeWorkspaceFile(
        instructionsPath,
        params.instructions,
        toolCallId,
        signal,
        toolContext,
      );
      if (saved.isError) {
        return rejected(
          saved.text || "Failed to save domain instructions.",
        );
      }
      const result = { subagentId: prefix, path: instructionsPath, instructions: params.instructions, updated: true };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  return [queryTool, getInstructionsTool, updateInstructionsTool, currentTimeTool];
};

const builtinSection = (
  key: string,
  label: string,
  trigger: "chat" | "background",
  promptPath: string,
): SubagentPromptSection => ({
  key,
  label,
  trigger,
  source: "builtin",
  sourcePath: `prompts/${promptPath}`,
  editable: false,
  content: loadPrompt(promptPath),
});

/**
 * 全仓唯一内置专职 Subagent 目录：
 * 每个 Subagent 静态绑定自身的提示词、工具、技能与 MCP（预留槽位），
 * 底层统一由 runSubagent 纯函数内存会话执行。
 */
export const createBuiltinSubagents = (deps: BuiltinSubagentsDeps): SubagentRegistration[] => {
  const sms: SubagentRegistration = {
    id: "sms",
    name: "短信助手",
    description: "处理手机短信与外部信息的查询、筛选过滤、提醒与静默偏好规则（subagents/sms/AGENTS.md）管理。",
    routingHint:
      "Route any SMS/information record query or SMS filtering/alert/ignore preference to `sms`. " +
      "Never store SMS filtering preferences only in global `memory` or `assistant/AGENTS.md`, because background SMS screening does not read them.",
    triggers: ["chat", "background"],
    defaultEnabled: false,
    onEnabledChanged: deps.onSmsEnabledChanged,
    executionPolicy: { stateless: true, parallelAllowed: true },
    prompts: () => [
      builtinSection("chat", "聊天路由任务提示词", "chat", "subagents/sms-chat.md"),
      builtinSection("realtime", "实时短信筛选提示词", "background", "sms/realtime.md"),
      builtinSection("archive", "归档短信批处理提示词", "background", "sms/archive.md"),
      builtinSection("briefing", "归档简报汇总提示词", "background", "sms/briefing.md"),
    ],
    tools: [
      { name: "sms_query", description: "只读查询短信概览、条目、单条详情与筛选运行记录", triggers: ["chat"] },
      { name: "sms_get_instructions", description: "读取短信显式指令、include 诊断与已归纳习惯", triggers: ["chat"] },
      { name: "sms_update_instructions", description: "提交合并后的短信指令全文（经版本绑定人工审批）", triggers: ["chat"], requiresApproval: true },
      { name: "currentTime", description: "读取服务端当前时间与时区", triggers: ["chat"] },
      { name: SUBMIT_INFORMATION_RESULT_TOOL_NAME, description: "提交结构化短信筛选决策、通知与习惯更新", triggers: ["background"] },
      { name: SUBMIT_INFORMATION_BRIEFING_TOOL_NAME, description: "提交归档短信简报", triggers: ["background"] },
    ],
    skills: [],
    mcp: [],
    userInstructions: {
      path: managedWorkspaceTexts.smsInstructions,
      read: () => deps.information.getPreferences(),
    },
    runChatTask: async (task, ctx) =>
      runStatelessChatSubagent(deps, {
        id: "sms",
        systemPrompt: loadPrompt("subagents/sms-chat.md"),
        tools: createDomainChatTools({
          prefix: "sms",
          instructionsPath: managedWorkspaceTexts.smsInstructions,
          readPreferences: () => deps.information.getPreferences(),
          query: (input) => deps.information.query(input),
          ctx,
        }),
        task,
        ctx,
      }),
  };

  const browser: SubagentRegistration = {
    id: "browser",
    name: "浏览器助手",
    description: "在独立内存上下文中操作共享真实 GUI Chrome 浏览器执行多步网页浏览、交互与信息提取，遇登录或验证码发起人工接管。",
    routingHint:
      "Route multi-step real browser interaction, login/CAPTCHA handoff, or complex webpage extraction to `browser` so large page snapshots stay isolated from main conversation history.",
    triggers: ["chat"],
    defaultEnabled: true,
    isAvailable: () => Boolean(deps.browser),
    executionPolicy: { stateless: true, parallelAllowed: false },
    prompts: () => [
      builtinSection("chat", "浏览器操作提示词", "chat", "subagents/browser.md"),
    ],
    tools: [
      { name: "browser", description: "操作共享真实 GUI Chrome（导航、快照、截图、批量交互、等待、人工接管）", triggers: ["chat"] },
      { name: "currentTime", description: "读取服务端当前时间与时区", triggers: ["chat"] },
      { name: "read", description: "只读查看工作区内的文本文件", triggers: ["chat"] },
      { name: "grep", description: "只读搜索工作区内的文本内容", triggers: ["chat"] },
    ],
    skills: [],
    mcp: [],
    runChatTask: async (task, ctx) => {
      if (!deps.browser) {
        return { agent: "browser", task, output: "Browser service is unavailable", isError: true };
      }
      const readOnlyWorkspaceTools = createFileTools(deps.layout.workspaceDir, {
        boundaryDir: deps.layout.workspaceDir,
      }).filter((tool) => tool.name === "read" || tool.name === "grep");
      return runStatelessChatSubagent(deps, {
        id: "browser",
        systemPrompt: loadPrompt("subagents/browser.md"),
        tools: [...createBrowserTools(deps.browser), currentTimeTool, ...readOnlyWorkspaceTools],
        task,
        ctx,
      });
    },
  };

  const habits: SubagentRegistration = {
    id: "habits",
    name: "习惯归纳助手",
    description: "后台定期分析各领域未消化用户反馈样本，结合显式指令增量归纳长期行为习惯。",
    triggers: ["background"],
    defaultEnabled: true,
    executionPolicy: { stateless: true, parallelAllowed: true },
    prompts: () => [
      builtinSection("consolidate", "行为习惯归纳提示词", "background", "habits/consolidate.md"),
    ],
    tools: [
      { name: "submit_habit_updates", description: "提交增量习惯变更（add/edit/delete）", triggers: ["background"] },
    ],
    skills: [],
    mcp: [],
  };

  const dream: SubagentRegistration = {
    id: "dream",
    name: "记忆整理助手",
    description: "后台定期整理主会话增量消息，提炼长期记忆与用户画像变更提案。",
    triggers: ["background"],
    defaultEnabled: true,
    executionPolicy: { stateless: true, parallelAllowed: false },
    prompts: () => [
      builtinSection("consolidate", "记忆整理主提示词", "background", "dream/consolidate.md"),
      builtinSection("hard-rules", "记忆整理硬规则", "background", "dream/hard-rules.md"),
    ],
    tools: [
      { name: PROPOSE_NOTES_TOOL_NAME, description: "提交结构化笔记变更建议（USER/SOUL/INSTRUCTIONS/MEMORY/pending）", triggers: ["background"] },
    ],
    skills: [],
    mcp: [],
  };

  return [sms, browser, habits, dream];
};
