import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationNotification } from "../../features/conversation/types.js";
import { SUBAGENT_ID_PATTERN } from "../../features/subagents/types.js";

/**
 * 服务端生成的确定性通知，不代表模型回复，也没有 token 消耗。
 * 使用 pi 的公开 message 写入接口，把稳定通知 ID 与可选 Subagent ID 随同一条 message
 * 存入唯一的 JSONL 历史，展示与模型上下文隔离均基于真实标记，不按正文猜测。
 */
type NotificationMessage = AssistantMessage & {
  personalBotNotificationId: string;
  personalBotSubagentId?: string;
  /** 仅用于只读兼容早期 JSONL 历史记录，不再新写入。 */
  personalBotDomainId?: string;
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

const legacySmsNotificationId = /^info-notification-inforun_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(0|[1-9][0-9]*)$/;

/** 读取可信服务端标记；旧历史按稳定 ID 或旧字段投影，避免把卡片带入模型上下文。 */
export const notificationSubagentIdOf = (message: AssistantMessage): string | undefined => {
  const id = notificationIdOf(message);
  if (!id) return undefined;
  const raw =
    "personalBotSubagentId" in message && message.personalBotSubagentId !== undefined
      ? message.personalBotSubagentId
      : "personalBotDomainId" in message
        ? message.personalBotDomainId
        : undefined;
  if (raw === undefined) return legacySmsNotificationId.test(id) ? "sms" : undefined;
  return typeof raw === "string" && SUBAGENT_ID_PATTERN.test(raw) ? raw : undefined;
};
