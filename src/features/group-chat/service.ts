import type { ConversationHistory, ExecutionEvent } from "../conversation/types.js";
import type { FeatureNotification, NotificationReference } from "../agent-extensions/types.js";
import { AgentCommunicationError, type AgentCommunication, type AgentRequestExecution, type AgentRequestReceipt } from "../agent-communication/service.js";

export type GroupTurn = {
  id: string; rootId: string; sourceAgentId: string | null; targetAgentId: string;
  discussionId: string; createdAt: string; finishedAt: string | null; status: "running" | "completed" | "failed" | "cancelled";
  notification?: NotificationReference;
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
  resolveNotification: (reference: NotificationReference) => Promise<{ targetAgentId: string; context: string }>;
}) => {
  const turns = new Map<string, GroupTurn>();
  let active: { id: string; controller: AbortController; emit: (event: GroupEvent) => void; notification?: NotificationReference } | undefined;
  const initialize = async () => {
    const saved = await deps.repository.read();
    for (const turn of saved) turns.set(turn.id, { ...turn, status: turn.status === "running" ? "cancelled" : turn.status });
    if (saved.some((turn) => turn.status === "running")) await deps.repository.update(() => [...turns.values()]);
  };
  const start = async (request: AgentRequestExecution) => {
    const parent = request.sourceDiscussionId ? [...turns.values()].findLast((turn) => turn.targetAgentId === request.sourceAgentId && turn.discussionId === request.sourceDiscussionId) : undefined;
    if (!request.userView && !parent) return;
    const notification = parent?.notification ?? (active?.id === request.requestId ? active.notification : undefined);
    const turn: GroupTurn = {
      id: request.requestId, rootId: parent ? parent.rootId : request.requestId,
      sourceAgentId: request.userView ? null : request.sourceAgentId, targetAgentId: request.targetAgentId,
      discussionId: request.discussionId, createdAt: new Date().toISOString(), finishedAt: null, status: "running",
      ...(notification ? { notification } : {}),
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
  const send = async (input: { id: string; content: string; targetAgentId?: string; notification?: NotificationReference }, signal: AbortSignal, emit: (event: GroupEvent) => void) => {
    if (active || turns.has(input.id)) throw new AgentCommunicationError("BUSY", "Group is busy or message was already accepted; read group history before sending again");
    if (input.notification && input.targetAgentId) throw new AgentCommunicationError("INVALID_INPUT", "Notification follow-up cannot specify a target agent");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    active = { id: input.id, controller, emit, notification: input.notification };
    try {
      // 每次追问先验证来源仍存在；客户端只传引用，不提供来源正文或执行目标。
      const source = input.notification ? await deps.resolveNotification(input.notification) : undefined;
      const targetAgentId = source?.targetAgentId ?? input.targetAgentId ?? "local-main";
      const sameNotification = (a: NotificationReference | undefined, b: NotificationReference | undefined) =>
        a && b ? a.targetAgentId === b.targetAgentId && a.sessionId === b.sessionId && a.messageId === b.messageId : a === b;
      const previous = [...turns.values()].findLast((turn) => turn.sourceAgentId === null && turn.targetAgentId === targetAgentId && sameNotification(turn.notification, input.notification));
      let discussionId = previous?.discussionId;
      if (discussionId) {
        try { await deps.history(targetAgentId, discussionId); }
        catch (error) {
          // 普通聊天首轮可能在创建 JSONL 前失败，可新建讨论；通知续聊缺失则明确报错，不丢失原事项背景。
          if (!(error instanceof AgentCommunicationError) || error.code !== "NOT_FOUND" || input.notification) throw error;
          discussionId = undefined;
        }
      }
      // 普通聊天按成员续接，通知按来源引用分开；都不拼接双方私聊或其他事项。
      await deps.communication.request({ sourceAgentId: targetAgentId, targetAgentId, message: input.content,
        ...(!discussionId && source ? { context: source.context } : {}),
        ...(discussionId ? { discussionId } : {}) }, controller.signal,
      { sessionId: "group-main", requestId: input.id, userView: input.notification ? "notification" : "group" });
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
