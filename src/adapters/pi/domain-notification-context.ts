import type { SubagentChatDescriptor } from "../../features/subagents/types.js";
import { renderPrompt } from "../prompts/loader.js";

export const SUBAGENTS_HEADING = "Specialized subagents";

export const buildSubagentsSystemPrompt = (
  subagents: readonly SubagentChatDescriptor[],
): string => {
  const lines = subagents.map((agent) =>
    agent.routingHint
      ? `- \`${agent.id}\` (${agent.name}): ${agent.description}\n  Routing note: ${agent.routingHint}`
      : `- \`${agent.id}\` (${agent.name}): ${agent.description}`,
  );
  return `\n${renderPrompt("assistant/subagents.md", {
    SUBAGENTS: lines.join("\n"),
  })}`;
};
