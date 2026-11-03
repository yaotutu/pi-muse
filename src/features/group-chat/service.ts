import type { ConversationHistory, ExecutionEvent } from "../conversation/types.js";
import type { FeatureNotification } from "../agent-extensions/types.js";
import { AgentCommunicationError, type AgentCommunication, type AgentRequestExecution, type AgentRequestReceipt } from "../agent-communication/service.js";

export type GroupTurn = {
  id: string; rootId: string; sourceAgentId: string | null; targetAgentId: string;
  discussionId: string; createdAt: string; finishedAt: string | null; status: "running" | "completed" | "failed" | "cancelled";
};
export type GroupRepository = {
  read: () => Promise<GroupTurn[]>;
  update: (change: (turns: GroupTurn[]) => GroupTurn[]) => Promise<void>;
};
export type GroupSnapshot = { id: "main"; defaultAgentId: "local-main"; turns: (GroupTurn & { messages: ConversationHistory })[]; notifications: FeatureNotification[]; running: string | null };
export type GroupEvent = { type: "turn"; turn: GroupTurn } | { type: "delta"; id: string; text: string } | { type: "settled" };

/** 群组只保存投递索引，正文仍在目标智能体的 pi 讨论中；群展示从不作为模型 prompt。 */
export const createGroupChat = (deps: {
  repository: GroupRepository; communication: AgentCommunication;
  history: (agentId: string, discussionId: string) => Promise<{ messages: ConversationHistory }>;
  notifications: () => Promise<FeatureNotification[]>;
}) => {
  const turns = new Map<string, GroupTurn>();
  let active: { id: string; controller: AbortController; emit: (event: GroupEvent) => void } | undefined;
  const initialize = async () => {
    const saved = await deps.repository.read();
    for (const turn of saved) turns.set(turn.id, { ...turn, status: turn.status === "running" ? "cancelled" : turn.status });
    if (saved.some((turn) => turn.status === "running")) await deps.repository.update(() => [...turns.values()]);
  };
  const start = async (request: AgentRequestExecution) => {
    const parent = request.sourceDiscussionId && [...turns.values()].findLast((turn) => turn.targetAgentId === request.sourceAgentId && turn.discussionId === request.sourceDiscussionId);
    if (!request.group && !parent) return;
    const turn: GroupTurn = {
      id: request.requestId, rootId: parent ? parent.rootId : request.requestId,
      sourceAgentId: request.group ? null : request.sourceAgentId, targetAgentId: request.targetAgentId,
      discussionId: request.discussionId, createdAt: new Date().toISOString(), finishedAt: null, status: "running",
    };
    await deps.repository.update((items) => [...items, turn]);
    turns.set(turn.id, turn);
    if (active?.id === turn.rootId) active.emit({ type: "turn", turn });
  };
  const finish = async (receipt: AgentRequestReceipt) => {
    const turn = turns.get(receipt.requestId);
    if (!turn) return;
    const next = { ...turn, status: receipt.status, finishedAt: new Date().toISOString() };
    await deps.repository.update((items) => items.map((item) => item.id === next.id ? next : item));
    turns.set(next.id, next);
  };
  const event = (requestId: string, value: ExecutionEvent) => {
    const turn = turns.get(requestId);
    if (turn && active?.id === turn.rootId && value.type === "text_delta") active.emit({ type: "delta", id: turn.id, text: value.delta });
  };
  const snapshot = async (): Promise<GroupSnapshot> => {
    // 群讨论与已验证功能通知分别投影；绝不拼接普通私聊，也不将展示投影用作模型上下文。
    const histories = new Map<string, Promise<ConversationHistory>>();
    return { id: "main", defaultAgentId: "local-main", running: active?.id ?? null, notifications: await deps.notifications(),
      turns: await Promise.all([...turns.values()].map(async (turn) => {
        const key = `${turn.targetAgentId}/${turn.discussionId}`;
        if (!histories.has(key)) histories.set(key, deps.history(turn.targetAgentId, turn.discussionId).then((result) => result.messages).catch((error) => {
          if (error instanceof AgentCommunicationError && error.code === "NOT_FOUND") return [];
          throw error;
        }));
        const history = await histories.get(key)!;
        const first = history.findIndex((message) => message.id === turn.id);
        const next = history.findIndex((message, index) => index > first && message.role === "user");
        return { ...turn, messages: first < 0 ? [] : history.slice(first, next < 0 ? undefined : next) };
      })) };
  };
  const send = async (input: { id: string; content: string; targetAgentId?: string }, signal: AbortSignal, emit: (event: GroupEvent) => void) => {
    if (active || turns.has(input.id)) throw new AgentCommunicationError("BUSY", "Group is busy or message was already accepted; read group history before sending again");
    const targetAgentId = input.targetAgentId ?? "local-main";
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    active = { id: input.id, controller, emit };
    try {
      const previous = [...turns.values()].findLast((turn) => turn.sourceAgentId === null && turn.targetAgentId === targetAgentId);
      let discussionId = previous?.discussionId;
      if (discussionId) {
        try { await deps.history(targetAgentId, discussionId); }
        catch (error) {
          // 首轮可能在 pi 创建 JSONL 前失败；下次新建讨论，不重发旧消息，也不吞掉损坏错误。
          if (!(error instanceof AgentCommunicationError) || error.code !== "NOT_FOUND") throw error;
          discussionId = undefined;
        }
      }
      // 每个成员在群里拥有自己的持久讨论；只接收发给自己的消息，与私聊独立。
      await deps.communication.request({ sourceAgentId: targetAgentId, targetAgentId, message: input.content,
        ...(discussionId ? { discussionId } : {}) }, controller.signal,
      { sessionId: "group-main", requestId: input.id, group: true });
    } finally {
      active = undefined;
      signal.removeEventListener("abort", abort);
    }
    emit({ type: "settled" });
  };
  const removeAgent = async (agentId: string) => {
    await deps.repository.update((items) => items.filter((turn) => turn.targetAgentId !== agentId));
    for (const [id, turn] of turns) if (turn.targetAgentId === agentId) turns.delete(id);
  };
  return { initialize, start, finish, event, snapshot, send, removeAgent,
    stop: (id: string) => { if (active?.id !== id) return false; active.controller.abort(); return true; } };
};
export type GroupChat = ReturnType<typeof createGroupChat>;
