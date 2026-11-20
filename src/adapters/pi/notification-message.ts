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

const legacySmsNotificationId = /^info-notification-inforun_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(0|[1-9][0-9]*)$/;

/** 读取可信服务端标记；旧短信按稳定 ID 投影，避免改写 JSONL 或把卡片带入模型上下文。 */
export const notificationDomainIdOf = (message: AssistantMessage): string | undefined => {
  const id = notificationIdOf(message);
  if (!id) return undefined;
  const domainId = "personalBotDomainId" in message ? message.personalBotDomainId : undefined;
  if (domainId === undefined) return legacySmsNotificationId.test(id) ? "sms" : undefined;
  return typeof domainId === "string" && DOMAIN_ID_PATTERN.test(domainId) ? domainId : undefined;
};
