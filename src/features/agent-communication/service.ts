import { randomUUID } from "node:crypto";
import { isAgentId } from "../conversation/agent-id.js";
import type { ConversationHub } from "../conversation/conversation-hub.js";
import type { ConversationHistory } from "../conversation/types.js";
import type { ExecutionEvent } from "../conversation/types.js";
import { FEATURE_NAMES, featureForAgent } from "../agent-extensions/types.js";
import { describeAgent } from "../agents/types.js";

export class AgentCommunicationError extends Error {
  constructor(public code: "INVALID_INPUT" | "NOT_FOUND" | "BUSY" | "SHUTDOWN", message: string) { super(message); }
}

export type AgentRequest = {
  sourceAgentId: string;
  targetAgentId: string;
  message: string;
  discussionId?: string;
  context?: string;
};
export type AgentRequestReceipt = {
  requestId: string;
  discussionId: string;
  sourceAgentId: string;
  sourceSessionId: string;
  sourceDiscussionId?: string;
  targetAgentId: string;
  status: "completed" | "failed" | "cancelled";
  text: string;
};
export type AgentRequestExecution = Required<Omit<AgentRequest, "context">> & {
  context?: string;
  requestId: string;
  sourceSessionId: string;
  sourceDiscussionId?: string;
  signal: AbortSignal;
  approvalOwner: { agentId: string; runId: string };
  userView?: "group" | "notification";
  onEvent?: (event: ExecutionEvent) => void;
};
export type AgentDiscussionHistory = { agentId: string; discussionId: string; messages: ConversationHistory };
export type AgentCommunicationRunner = {
  run: (request: AgentRequestExecution, continuing: boolean) => Promise<Pick<AgentRequestReceipt, "status" | "text">>;
  history: (agentId: string, discussionId: string) => Promise<AgentDiscussionHistory>;
  removeDiscussions: (agentId: string) => Promise<void>;
};
export type AgentCaller = {
  sessionId: string;
  discussionId?: string;
  approvalOwner?: { agentId: string; runId: string };
  requestId?: string;
  userView?: "group" | "notification";
};

const validDiscussionId = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const invalid = () => new AgentCommunicationError("INVALID_INPUT", "Invalid agent communication request");

/** 智能体默认互信；此处只协调执行、回复关联和生命周期，不维护调用白名单或绑定权限。 */
export const createAgentCommunication = (deps: { hub: ConversationHub; runner: AgentCommunicationRunner; timeoutMs: number;
  onStart?: (request: AgentRequestExecution) => Promise<void>;
  onFinish?: (receipt: AgentRequestReceipt) => Promise<void>;
  onEvent?: (requestId: string, event: ExecutionEvent) => void;
}) => {
  const active = new Map<string, { sourceAgentId: string; targetAgentId: string; controller: AbortController; done: Promise<void> }>();
  const paused = new Map<string, number>();
  let closed = false;
  const checkOpen = (...agentIds: string[]) => {
    if (closed) throw new AgentCommunicationError("SHUTDOWN", "Agent communication is closing");
    if (agentIds.some((id) => paused.has(id))) throw new AgentCommunicationError("BUSY", "Agent is being reset or deleted");
  };
  const requireAgent = async (agentId: string) => {
    const agent = await deps.hub.findAgent(agentId);
    if (!agent) throw new AgentCommunicationError("NOT_FOUND", "Agent not found");
    return agent;
  };
  const listAgents = async () => ({ agents: (await deps.hub.agents()).map(describeAgent) });

  const request = async (input: AgentRequest, signal?: AbortSignal, caller?: AgentCaller): Promise<AgentRequestReceipt> => {
    if (!isAgentId(input.sourceAgentId) || !isAgentId(input.targetAgentId) ||
      typeof input.message !== "string" || !input.message.trim() || input.message.length > 20000 ||
      (input.context !== undefined && (typeof input.context !== "string" || input.context.length > 20000)) ||
      (input.discussionId !== undefined && !validDiscussionId(input.discussionId))) throw invalid();
    checkOpen(input.sourceAgentId, input.targetAgentId);
    signal?.throwIfAborted();
    const [source] = await Promise.all([requireAgent(input.sourceAgentId), requireAgent(input.targetAgentId)]);
    checkOpen(input.sourceAgentId, input.targetAgentId);
    signal?.throwIfAborted();
    const discussionId = input.discussionId ?? randomUUID();
    const key = `${input.targetAgentId}/${discussionId}`;
    if (active.has(key)) throw new AgentCommunicationError("BUSY", "Discussion is already processing a request");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, deps.timeoutMs);
    const requestId = caller?.requestId ?? randomUUID();
    const sourceSessionId = caller?.sessionId ?? source.sessionId();
    const sourceDiscussionId = caller?.discussionId;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    active.set(key, { sourceAgentId: input.sourceAgentId, targetAgentId: input.targetAgentId, controller, done });
    try {
      // 回复作为本次调用结果返回，绝不等待来源会话的通知队列，也不重新解析默认通知绑定。
      const execution = { ...input, requestId, discussionId, sourceSessionId, sourceDiscussionId, signal: controller.signal, userView: caller?.userView,
        onEvent: (event: ExecutionEvent) => deps.onEvent?.(requestId, event),
        approvalOwner: caller?.approvalOwner ?? { agentId: input.sourceAgentId, runId: requestId } };
      await deps.onStart?.(execution);
      const result = await deps.runner.run(execution, input.discussionId !== undefined);
      const receipt = { requestId, discussionId, sourceAgentId: input.sourceAgentId, sourceSessionId, ...(sourceDiscussionId ? { sourceDiscussionId } : {}), targetAgentId: input.targetAgentId,
        ...(controller.signal.aborted ? { status: "cancelled" as const, text: "Agent request was cancelled" } : result) };
      await deps.onFinish?.(receipt);
      return receipt;
    } catch (error) {
      await deps.onFinish?.({ requestId, discussionId, sourceAgentId: input.sourceAgentId, sourceSessionId, targetAgentId: input.targetAgentId,
        status: controller.signal.aborted ? "cancelled" : "failed", text: "Agent request failed" });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      active.delete(key);
      finish();
    }
  };

  const history = async (agentId: string, discussionId: string) => {
    if (!isAgentId(agentId) || !validDiscussionId(discussionId)) throw invalid();
    checkOpen(agentId);
    await requireAgent(agentId);
    checkOpen(agentId);
    if (active.has(`${agentId}/${discussionId}`)) throw new AgentCommunicationError("BUSY", "Discussion is processing a request");
    return deps.runner.history(agentId, discussionId);
  };
  const pauseAgent = (agentId: string) => {
    paused.set(agentId, (paused.get(agentId) ?? 0) + 1);
    const runs = [...active.values()].filter((run) => run.sourceAgentId === agentId || run.targetAgentId === agentId);
    for (const run of runs) run.controller.abort();
    let resumed = false;
    return { stopped: Promise.all(runs.map((run) => run.done)), resume: () => {
      if (resumed) return;
      resumed = true;
      const count = (paused.get(agentId) ?? 1) - 1;
      if (count) paused.set(agentId, count); else paused.delete(agentId);
    } };
  };
  const close = async () => {
    closed = true;
    const runs = [...active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  };
  return { listAgents, request, history, pauseAgent, removeDiscussions: deps.runner.removeDiscussions, close };
};
export type AgentCommunication = ReturnType<typeof createAgentCommunication>;
