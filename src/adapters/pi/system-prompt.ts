import type { SubagentChatDescriptor } from "../../features/subagents/types.js";
import type { DataLayout } from "../storage/data-layout.js";
import { readResolvedProfileFile } from "../storage/workspace-document-includes.js";
import type { MemoryService } from "../../features/memory/memory-service.js";
import type { MemoryItem } from "../../features/memory/types.js";
import { loadPrompt, renderPrompt } from "../prompts/loader.js";

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

const section = (heading: string, text: string): string =>
  text ? `\n\n## ${heading}\n${text}` : "";

export type SystemPromptOptions = {
  layout: Pick<DataLayout, "soulFile" | "userFile" | "workspaceDir"> & Partial<Pick<DataLayout, "bootstrapFile">>;
  memory: Pick<MemoryService, "renderForPrompt">;
  /** 最终模型工具名单：已经包含会话技能与可用能力过滤。 */
  allowedToolNames: readonly string[];
  assistantInstructions?: string;
  recalledMemories?: readonly MemoryItem[];
  chatSubagents?: readonly SubagentChatDescriptor[];
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
  { tools: ["browser"], promptPath: "assistant/tools/browser.md" },
];

/** 每轮重新读取 prompts/*.md、profile 与显式身份；业务说明只跟随本轮实际可用工具。 */
export const buildSystemPrompt = async ({
  layout,
  memory,
  allowedToolNames,
  assistantInstructions,
  recalledMemories,
  chatSubagents,
}: SystemPromptOptions): Promise<string> => {
  const tools = new Set(allowedToolNames);
  const has = (...names: readonly string[]) => names.every((name) => tools.has(name));

  const capabilitySegments: string[] = [
    loadPrompt("assistant/base.md"),
    ...toolSections.filter((entry) => has(...entry.tools)).map((entry) => loadPrompt(entry.promptPath)),
  ];
  if (has("subagent") && chatSubagents?.length) {
    capabilitySegments.push(buildSubagentsSystemPrompt(chatSubagents).replace(/^\n/, ""));
  }
  capabilitySegments.push(
    ...trailingToolSections.filter((entry) => has(...entry.tools)).map((entry) => loadPrompt(entry.promptPath)),
  );

  const soul = (await readResolvedProfileFile(layout.soulFile, layout.workspaceDir)).trim();
  const user = (await readResolvedProfileFile(layout.userFile, layout.workspaceDir)).trim();
  const bootstrap = !soul && !user && layout.bootstrapFile
    ? (await readResolvedProfileFile(layout.bootstrapFile, layout.workspaceDir)).trim()
    : "";

  return capabilitySegments.join("\n") +
    section("First-run onboarding (BOOTSTRAP)", bootstrap) +
    section("Your identity (SOUL)", soul) +
    section("The user (USER)", user) +
    section("Assistant instructions", assistantInstructions ?? "") +
    (await memory.renderForPrompt({ includeMemory: has("memory_search"), recalledMemories }));
};
