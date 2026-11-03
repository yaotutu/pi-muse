import type { AgentSnapshot } from "../conversation/conversation-hub.js";
import { FEATURE_IDS, FEATURE_AGENTS, FEATURE_NAMES, type FeatureId } from "../agent-extensions/types.js";

/** 所有智能体共用身份与会话能力；extensions 只描述附加业务，不划分能力等级。 */
export type AgentInfo = AgentSnapshot & { name?: string; extensions: FeatureId[] };
export const describeAgent = (agent: AgentSnapshot): AgentInfo => {
  const extensions = FEATURE_IDS.filter((id) => FEATURE_AGENTS[id] === agent.id);
  return { ...agent, ...(extensions[0] ? { name: FEATURE_NAMES[extensions[0]] } : {}), extensions };
};

export type AgentStorage = {
  exists: (agentId: string) => Promise<boolean>;
  clearSessions: (agentId: string) => Promise<void>;
  remove: (agentId: string) => Promise<void>;
};
export class AgentError extends Error {
  constructor(public status: 400 | 404 | 409, public code: string, message: string) { super(message); }
}
