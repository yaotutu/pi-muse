import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationNotification } from "../../features/conversation/types.js";
import { DOMAIN_ID_PATTERN } from "../../features/domain-agents/types.js";

/**
 * 服务端生成的确定性通知，不代表模型回复，也没有 token 消耗。
 * 使用 pi 的公开 message 写入接口，把稳定通知 ID 与可选领域 ID 随同一条 message
 * 存入唯一的 JSONL 历史，展示与模型上下文隔离均基于真实标记，不按正文猜测。
 */
type NotificationMessage = AssistantMessage & {
  personalBotNotificationId: string;
  personalBotDomainId?: string;
};

export const createNotificationMessage = (notification: ConversationNotification): NotificationMessage => ({
  role: "assistant",
  content: [{ type: "text", text: notification.text }],
  provider: "personal-bot",
  model: "server-notification",
  api: "openai-completions",
  personalBotNotificationId: notification.id,
  ...(notification.domainId ? { personalBotDomainId: notification.domainId } : {}),
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

/** 仅当服务端通知标记有效且携带合法领域 ID 时返回所属领域，供上下文隔离与历史投影复用。 */
export const notificationDomainIdOf = (message: AssistantMessage): string | undefined => {
  if (!notificationIdOf(message)) return undefined;
  const domainId = "personalBotDomainId" in message ? message.personalBotDomainId : undefined;
  return typeof domainId === "string" && DOMAIN_ID_PATTERN.test(domainId) ? domainId : undefined;
};
