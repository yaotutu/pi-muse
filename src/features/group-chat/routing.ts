import { AgentCommunicationError } from "../agent-communication/service.js";

export type GroupSettings = { name: string; purpose: string; memberIds: string[]; defaultAgentId: string; instructions: string };
export type RoutingMember = { id: string; name: string; capability: string };
export type RouteDecision = { mode: "direct" | "confirm"; targetAgentIds: string[]; reason: string };
export type RouteInput = { content: string; settings: GroupSettings; members: RoutingMember[] };
export type RoutingRepository = {
  read: () => Promise<{ group: GroupSettings | null; capabilities: Record<string, string> }>;
  update: (change: (value: Awaited<ReturnType<RoutingRepository["read"]>>) => Awaited<ReturnType<RoutingRepository["read"]>>) => Promise<void>;
};

const defaults: Record<string, string> = {
  "local-main": "日常聊天、一般问答和协作协调；明确属于其他成员的任务不重复代答。",
  "sms-internal": "查询和分析用户短信，处理短信提醒偏好。",
  "news-internal": "查询、阅读和讨论新闻，管理 RSS 订阅与新闻偏好。",
};

/** 能力说明是公开目录，不读取成员指令、文件或私聊；当前只配置一个默认组，不建设多层调度。 */
export const createGroupRouting = (deps: { repository: RoutingRepository; agents: () => Promise<{ id: string; name?: string }[]>;
  decide: (input: RouteInput, signal: AbortSignal) => Promise<RouteDecision> }) => {
  const members = async (): Promise<RoutingMember[]> => {
    const [agents, stored] = await Promise.all([deps.agents(), deps.repository.read()]);
    return agents.map((agent) => ({ id: agent.id, name: agent.name ?? agent.id,
      capability: stored.capabilities[agent.id] ?? defaults[agent.id] ?? "" }));
  };
  const settings = async (): Promise<GroupSettings> => {
    const stored = await deps.repository.read();
    return stored.group ?? { name: "全部", purpose: "与智能体协作", memberIds: (await deps.agents()).map((agent) => agent.id), defaultAgentId: "local-main", instructions: "" };
  };
  const saveSettings = async (value: GroupSettings) => {
    const known = new Set((await deps.agents()).map((agent) => agent.id));
    if (!value.memberIds.includes(value.defaultAgentId) || value.memberIds.some((id) => !known.has(id)) || new Set(value.memberIds).size !== value.memberIds.length)
      throw new AgentCommunicationError("INVALID_INPUT", "Default agent must be a member; all members must exist and be unique");
    await deps.repository.update((stored) => ({ ...stored, group: value }));
    return value;
  };
  const capability = async (agentId: string) => {
    const member = (await members()).find((agent) => agent.id === agentId);
    if (!member) throw new AgentCommunicationError("NOT_FOUND", "Agent not found");
    return { agentId, capability: member.capability };
  };
  const saveCapability = async (agentId: string, text: string) => {
    await capability(agentId);
    await deps.repository.update((stored) => ({ ...stored, capabilities: { ...stored.capabilities, [agentId]: text } }));
    return { agentId, capability: text };
  };
  const route = async (content: string, signal: AbortSignal): Promise<RouteDecision> => {
    const config = await settings();
    const available = (await members()).filter((agent) => config.memberIds.includes(agent.id));
    if (!available.some((agent) => agent.id === config.defaultAgentId)) throw new AgentCommunicationError("NOT_FOUND", "Default agent no longer exists");
    if (available.length === 1) return { mode: "direct", targetAgentIds: [config.defaultAgentId], reason: "" };
    const result = await deps.decide({ content, settings: config, members: available }, signal);
    signal.throwIfAborted();
    if (!result.targetAgentIds.length || new Set(result.targetAgentIds).size !== result.targetAgentIds.length ||
      result.targetAgentIds.some((id) => !available.some((agent) => agent.id === id)) ||
      (result.mode === "direct" && result.targetAgentIds.length !== 1))
      throw new AgentCommunicationError("INVALID_INPUT", "Invalid routing decision; no message was forwarded");
    return result;
  };
  const removeAgent = async (agentId: string) => {
    await deps.repository.update((stored) => {
      const capabilities = { ...stored.capabilities }; delete capabilities[agentId];
      return { capabilities, group: stored.group ? { ...stored.group, memberIds: stored.group.memberIds.filter((id) => id !== agentId) } : null };
    });
  };
  return { settings, saveSettings, members, capability, saveCapability, route, removeAgent,
    validate: deps.repository.read,
    assertCanDelete: async (agentId: string) => { if ((await settings()).defaultAgentId === agentId) throw new AgentCommunicationError("BUSY", "Choose another group default agent before deleting this agent"); } };
};
export type GroupRouting = ReturnType<typeof createGroupRouting>;
