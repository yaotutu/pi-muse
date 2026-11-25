import {
  SUBAGENT_ID_PATTERN,
  type SubagentChatDescriptor,
  type SubagentChatRunContext,
  type SubagentChatRunResult,
  type SubagentDetail,
  type SubagentEditability,
  type SubagentRegistration,
  type SubagentSummary,
} from "./types.js";

export type SubagentErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "UNAVAILABLE";

export class SubagentError extends Error {
  readonly code: SubagentErrorCode;

  constructor(code: SubagentErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SubagentError";
  }
}

export type CreateSubagentRegistryOptions = {
  agents: readonly SubagentRegistration[];
};

const buildEditability = (agent: SubagentRegistration): SubagentEditability => ({
  systemPrompts: "readonly",
  userInstructions: agent.userInstructions ? "editable" : "none",
  tools: "readonly",
  skills: "readonly",
  mcp: "readonly",
});

/**
 * 统一 Subagent 注册中心：
 * - 所有专职 Subagent 提前静态声明自身提示词、工具、技能与 MCP（预留）；
 * - 对外提供只读能力检视（前端 /api/subagents）与主聊天统一路由；
 * - 所有执行均为纯函数语义（无跨次聊天上下文），仅在单次执行周期内持有独立内存会话。
 */
export const createSubagentRegistry = (options: CreateSubagentRegistryOptions) => {
  const byId = new Map<string, SubagentRegistration>();
  for (const agent of options.agents) {
    if (!SUBAGENT_ID_PATTERN.test(agent.id)) {
      throw new SubagentError("INVALID_INPUT", `Invalid subagent ID: ${agent.id}`);
    }
    if (byId.has(agent.id)) {
      throw new SubagentError("INVALID_INPUT", `Duplicate subagent ID: ${agent.id}`);
    }
    if (agent.triggers.includes("chat") && !agent.runChatTask) {
      throw new SubagentError("INVALID_INPUT", `Chat-enabled subagent ${agent.id} must provide runChatTask`);
    }
    byId.set(agent.id, agent);
  }
  const ordered = [...byId.values()];

  const requireAgent = (rawId: string): SubagentRegistration => {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (!SUBAGENT_ID_PATTERN.test(id)) {
      throw new SubagentError("INVALID_INPUT", "Invalid subagent ID");
    }
    const agent = byId.get(id);
    if (!agent) {
      throw new SubagentError("NOT_FOUND", `Unknown subagent: ${id}`);
    }
    return agent;
  };

  const toSummary = async (agent: SubagentRegistration): Promise<SubagentSummary> => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    routingHint: agent.routingHint?.trim() || null,
    triggers: [...agent.triggers],
    enabled: agent.isEnabled ? Boolean(await agent.isEnabled()) : true,
    executionPolicy: { ...agent.executionPolicy },
    hasUserInstructions: Boolean(agent.userInstructions),
    capabilities: {
      tools: agent.tools.map((tool) => ({ ...tool, triggers: [...tool.triggers] })),
      skills: agent.skills.map((skill) => ({ ...skill })),
      mcp: agent.mcp.map((server) => ({ ...server })),
    },
    editability: buildEditability(agent),
  });

  const list = async (): Promise<{ subagents: SubagentSummary[] }> => ({
    subagents: await Promise.all(ordered.map((agent) => toSummary(agent))),
  });

  const getDetail = async (id: string): Promise<SubagentDetail> => {
    const agent = requireAgent(id);
    const [summary, prompts, instructions] = await Promise.all([
      toSummary(agent),
      Promise.resolve(agent.prompts()),
      agent.userInstructions ? agent.userInstructions.read() : Promise.resolve(undefined),
    ]);
    return {
      ...summary,
      prompts: prompts.map((section) => ({ ...section })),
      userInstructions:
        agent.userInstructions && instructions
          ? {
              path: agent.userInstructions.path,
              ...instructions,
            }
          : null,
    };
  };

  const listChatDescriptors = async (): Promise<SubagentChatDescriptor[]> => {
    const descriptors: SubagentChatDescriptor[] = [];
    for (const agent of ordered) {
      if (!agent.triggers.includes("chat")) continue;
      const available = agent.isChatAvailable
        ? Boolean(await agent.isChatAvailable())
        : agent.isEnabled && !agent.triggers.includes("background")
          ? Boolean(await agent.isEnabled())
          : true;
      if (!available) continue;
      descriptors.push({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        ...(agent.routingHint?.trim() ? { routingHint: agent.routingHint.trim() } : {}),
        parallelAllowed: agent.executionPolicy.parallelAllowed,
      });
    }
    return descriptors;
  };

  const runChatTask = async (
    id: string,
    task: string,
    ctx: SubagentChatRunContext,
  ): Promise<SubagentChatRunResult> => {
    const agent = requireAgent(id);
    if (!agent.triggers.includes("chat") || !agent.runChatTask) {
      throw new SubagentError("UNAVAILABLE", `Subagent ${agent.id} cannot be invoked from chat`);
    }
    const available = agent.isChatAvailable
      ? Boolean(await agent.isChatAvailable())
      : agent.isEnabled && !agent.triggers.includes("background")
        ? Boolean(await agent.isEnabled())
        : true;
    if (!available) {
      throw new SubagentError("UNAVAILABLE", `Subagent ${agent.id} is currently disabled`);
    }
    return agent.runChatTask(task, ctx);
  };

  return {
    list,
    getDetail,
    listChatDescriptors,
    runChatTask,
  };
};

export type SubagentRegistry = ReturnType<typeof createSubagentRegistry>;
