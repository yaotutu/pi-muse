import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationNotification } from "../../features/conversation/types.js";
import { SUBAGENT_ID_PATTERN } from "../../features/subagents/types.js";

/**
 * 服务端生成的确定性通知，不代表模型回复，也没有 token 消耗。
 * 使用 pi 的公开 message 写入接口，把稳定通知 ID 与可选 Subagent ID 随同一条 message
 * 存入唯一的 JSONL 历史，展示归属基于真实标记，不按正文猜测。
 */
type NotificationMessage = AssistantMessage & {
  personalBotNotificationId: string;
  personalBotSubagentId?: string;
};

export const createNotificationMessage = (notification: ConversationNotification): NotificationMessage => ({
  role: "assistant",
  content: [{ type: "text", text: notification.text }],
  provider: "personal-bot",
  model: "server-notification",
  api: "openai-completions",
  personalBotNotificationId: notification.id,
  ...(notification.subagentId ? { personalBotSubagentId: notification.subagentId } : {}),
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

export const notificationIdOf = (message: AssistantMessage): string | undefined => {
  const id = "personalBotNotificationId" in message ? message.personalBotNotificationId : undefined;
  return message.provider === "personal-bot" && message.model === "server-notification" && typeof id === "string"
    ? id : undefined;
};

/** 读取可信服务端标记的 Subagent 来源 ID。 */
export const notificationSubagentIdOf = (message: AssistantMessage): string | undefined => {
  const id = notificationIdOf(message);
  if (!id) return undefined;
  const raw = "personalBotSubagentId" in message ? message.personalBotSubagentId : undefined;
  return typeof raw === "string" && SUBAGENT_ID_PATTERN.test(raw) ? raw : undefined;
};
