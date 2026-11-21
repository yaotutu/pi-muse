import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { DomainAgentPromptSummary } from "../../features/domain-agents/types.js";
import { notificationDomainIdOf } from "./notification-message.js";

type AgentMessage = ContextEvent["messages"][number];

export const DOMAIN_AGENTS_HEADING = "Background domain agents";

export const buildDomainAgentsSystemPrompt = (
  domains: readonly DomainAgentPromptSummary[],
): string => {
  const domainLines = domains.map(
    (domain) => `- \`${domain.id}\` (${domain.name}): ${domain.summary}`,
  );
  return `
## ${DOMAIN_AGENTS_HEADING}
Pi Muse runs isolated background domain agents (each with its own domain-specific prompt, explicit rule board, and learned sensitivity profile — no chat tools/skills and no access to main conversation history or global \`memory\`).
Registered background domain agents:
${domainLines.join("\n")}

Isolation & card quoting:
- Domain notification cards posted into chat are excluded from your conversation context by default unless the user explicitly quotes one (format: \`【领域引用:<domainId>】...【引用结束】\`).
- Never guess silent items or unseen domain cards.

How to collaborate with domain agents via \`domain_agent\`:
- Use \`list\` / \`query\` / \`get_rules\` to inspect registered domain agents, items, runs, or current rules.
- IMPORTANT RULE ROUTING: Whenever the user states a filtering, alert, notification, ignore, or recommendation preference for any registered domain (e.g. SMS reminders/filtering -> \`sms\`, news recommendations/topics -> \`news\`, whether quoting a domain card or speaking directly in chat), you MUST persist that rule into that domain using \`domain_agent\`:
  1. Call \`get_rules\` for that \`domain\` first so you preserve existing rules;
  2. Concisely merge the user's new rule without dropping existing rules;
  3. Call \`update_rules\` with the merged \`notes\` and a concise \`reason\`. The user must approve the full rule-file diff.
- NEVER store domain filtering/notification rules ONLY in global \`memory\` or \`instructions\`, because background domain agents cannot read \`memory\` or \`instructions\`.
- After \`update_rules\` succeeds, briefly state the updated rule summary in your reply so the user can verify it. If approval is refused, cancelled or expires, state that the rule was not saved.
- Only call \`update_rules\` when the user explicitly states or requests a domain preference; do not invent unsolicited rule changes.`;
};

/**
 * 仅投影模型上下文；pi 的 context hook 已传入历史克隆，存储与 UI 继续读取原对象。
 * 所有带领域标识的后台子 Agent 通知卡片默认不进入主会话大模型上下文，
 * 避免零碎背景消息污染主对话（用户主动引用某张卡片时，内容会直接出现在用户消息中）。
 */
export const projectDomainNotificationContext = (
  messages: readonly AgentMessage[],
): AgentMessage[] => {
  const projected = messages.filter((message) => {
    if (message.role !== "assistant") return true;
    return !notificationDomainIdOf(message);
  });
  return projected.length === messages.length ? [...messages] : projected;
};

export const createDomainNotificationContextExtension = (): ExtensionFactory =>
  (pi) => {
    pi.on("context", (event) => ({ messages: projectDomainNotificationContext(event.messages) }));
  };
