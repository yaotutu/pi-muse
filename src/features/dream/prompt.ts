import type { DreamWindow } from "./types.js";

const renderMessages = (messages: DreamWindow["fresh"]) =>
  messages.map((message) => `[${message.id}] ${message.role}: ${message.text}`).join("\n\n");

/** 当前已有的笔记，供模型对照去重；每条记忆带 id，才能被引用修改或删除。 */
export type DreamExisting = {
  user: string;
  soul: string;
  instructions: string;
  memories: { id: string; text: string }[];
};

/** 整理轮的用户消息：现有笔记、重叠上下文和待整理消息分段标明，防止从上下文段提取。 */
export const buildDreamInput = (window: DreamWindow, existing: DreamExisting): string => {
  const parts = [
    `## Existing USER notes\n${existing.user || "(empty)"}`,
    `## Existing SOUL notes\n${existing.soul || "(empty)"}`,
    `## Existing shared assistant INSTRUCTIONS\n${existing.instructions || "(empty)"}`,
    `## Existing memories\n${existing.memories.length
      ? existing.memories.map((item) => `[${item.id}] ${item.text}`).join("\n")
      : "(none)"}`,
  ];
  if (window.summary) parts.push(`## Conversation summary (context only)\n${window.summary}`);
  if (window.context.length)
    parts.push(`## Earlier context (already processed; do not extract from it)\n${renderMessages(window.context)}`);
  parts.push(`## New messages (extract from these)\n${renderMessages(window.fresh)}`);
  return parts.join("\n\n");
};
