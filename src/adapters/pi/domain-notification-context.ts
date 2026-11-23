import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { DomainAgentPromptSummary } from "../../features/domain-agents/types.js";
import { renderPrompt } from "../prompts/loader.js";
import { notificationDomainIdOf } from "./notification-message.js";

type AgentMessage = ContextEvent["messages"][number];

export const DOMAIN_AGENTS_HEADING = "Background domain agents";

export const buildDomainAgentsSystemPrompt = (
  domains: readonly DomainAgentPromptSummary[],
): string => {
  const domainLines = domains.map(
    (domain) => `- \`${domain.id}\` (${domain.name}): ${domain.summary}`,
  );
  return `\n${renderPrompt("assistant/domain-agents.md", {
    DOMAINS: domainLines.join("\n"),
  })}`;
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
