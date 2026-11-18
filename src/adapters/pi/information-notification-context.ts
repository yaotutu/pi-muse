import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { informationNotificationSourceOf } from "./notification-message.js";

type AgentMessage = ContextEvent["messages"][number];

export const INFORMATION_BACKGROUND_HEADING = "Information background notifications";

export const INFORMATION_BACKGROUND_SYSTEM_PROMPT = `
## ${INFORMATION_BACKGROUND_HEADING}
Pi Muse has enabled its global information background. A separate temporary PI session
processes bounded pending batches with independent SMS preference notes, learned sensitivity
notes, and limited current feedback examples. Only a notify decision writes an independent
SMS notification card into the chat UI; silent and failed batches do not create chat messages.
Those independent SMS notification cards are excluded from this chat model's context by
default unless the user explicitly quotes one in a user message. Never guess the content
of silent items or unseen notification cards. Use the global information tool (overview,
items, item, runs, run, or preferences) to trace reasons and links when the user asks about
ingested items, runs, or preferences. That read-only tool cannot ingest information, change
information settings or preferences, start processing, or publish notifications.
Feedback examples are bounded local evidence for the SMS subagent, not global memory.
This feature does not provide operating-system push or SMS delivery.`;

/**
 * 仅投影模型上下文；pi 的 context hook 已传入历史克隆，存储与 UI 继续读取原对象。
 * 短信通知以独立卡片形式展示在聊天界面中，组装发往主会话大模型的上下文时将其彻底剔除，
 * 避免零碎短信污染主对话上下文（用户主动引用某张短信卡片时，内容会直接出现在用户消息中）。
 */
export const projectInformationNotificationContext = (
  messages: readonly AgentMessage[],
  _informationEnabled = true,
): AgentMessage[] => {
  const projected = messages.filter((message) => {
    if (message.role !== "assistant") return true;
    return !informationNotificationSourceOf(message);
  });
  return projected.length === messages.length ? [...messages] : projected;
};

export const createInformationNotificationContextExtension = (informationEnabled = true): ExtensionFactory =>
  (pi) => {
    pi.on("context", (event) => ({ messages: projectInformationNotificationContext(event.messages, informationEnabled) }));
  };
