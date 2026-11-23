import { buildDomainAgentsSystemPrompt } from "./domain-notification-context.js";
import type { DomainAgentPromptSummary } from "../../features/domain-agents/types.js";
import { ACTIVITY_TOOL_INSTRUCTIONS } from "./tools/activity.js";
import type { DataLayout } from "../storage/data-layout.js";
import { readResolvedProfileFile } from "../storage/workspace-document-includes.js";
import type { MemoryService } from "../../features/memory/memory-service.js";
import type { MemoryItem } from "../../features/memory/types.js";
import { loadPrompt } from "../prompts/loader.js";

const section = (heading: string, text: string): string =>
  text ? `\n\n## ${heading}\n${text}` : "";

export type SystemPromptOptions = {
  layout: Pick<DataLayout, "soulFile" | "userFile" | "workspaceDir">;
  memory: Pick<MemoryService, "renderForPrompt">;
  /** 最终模型工具名单：已经包含会话技能与 child 角色过滤。 */
  allowedToolNames: readonly string[];
  assistantInstructions?: string;
  recalledMemories?: readonly MemoryItem[];
  domainAgents?: readonly DomainAgentPromptSummary[];
};

const toolSections: ReadonlyArray<{ tools: readonly string[]; promptPath: string }> = [
  { tools: ["read", "grep", "find", "ls"], promptPath: "assistant/tools/files.md" },
  { tools: ["currentTime"], promptPath: "assistant/tools/current-time.md" },
  { tools: ["database"], promptPath: "assistant/tools/database.md" },
  { tools: ["write", "edit"], promptPath: "assistant/tools/write.md" },
  { tools: ["instructions"], promptPath: "assistant/tools/instructions.md" },
  { tools: ["skills"], promptPath: "assistant/tools/skills.md" },
];

const trailingToolSections: ReadonlyArray<{ tools: readonly string[]; promptPath: string }> = [
  { tools: ["memory", "memory_search"], promptPath: "assistant/tools/memory.md" },
  { tools: ["schedule"], promptPath: "assistant/tools/schedule.md" },
  { tools: ["monitor"], promptPath: "assistant/tools/monitor.md" },
  { tools: ["goal"], promptPath: "assistant/tools/goal.md" },
  { tools: ["get_weather"], promptPath: "assistant/tools/weather.md" },
  { tools: ["search_web", "web_fetch"], promptPath: "assistant/tools/web.md" },
  { tools: ["navigate", "snapshot", "act", "tab"], promptPath: "assistant/tools/browser.md" },
];

/** 每轮重新读取 prompts/*.md、profile 与显式身份；业务说明只跟随本轮实际可用工具。 */
export const buildSystemPrompt = async ({
  layout,
  memory,
  allowedToolNames,
  assistantInstructions,
  recalledMemories,
  domainAgents,
}: SystemPromptOptions): Promise<string> => {
  const tools = new Set(allowedToolNames);
  const has = (...names: readonly string[]) => names.every((name) => tools.has(name));

  const capabilitySegments: string[] = [
    loadPrompt("assistant/base.md"),
    ...toolSections.filter((entry) => has(...entry.tools)).map((entry) => loadPrompt(entry.promptPath)),
  ];
  if (has("domain_agent") && domainAgents?.length) {
    capabilitySegments.push(buildDomainAgentsSystemPrompt(domainAgents).replace(/^\n/, ""));
  }
  if (has("activity")) {
    capabilitySegments.push(`\n## Work activity management\n${ACTIVITY_TOOL_INSTRUCTIONS}`);
  }
  capabilitySegments.push(
    ...trailingToolSections.filter((entry) => has(...entry.tools)).map((entry) => loadPrompt(entry.promptPath)),
  );

  return capabilitySegments.join("\n") +
    section("Your identity (SOUL)", (await readResolvedProfileFile(layout.soulFile, layout.workspaceDir)).trim()) +
    section("The user (USER)", (await readResolvedProfileFile(layout.userFile, layout.workspaceDir)).trim()) +
    section("Assistant instructions", assistantInstructions ?? "") +
    (await memory.renderForPrompt({ includeMemory: has("memory_search"), recalledMemories }));
};
