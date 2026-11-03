import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentStorage } from "../../features/agents/types.js";
import { agentSessionsDir, agentWorkspaceDir, type DataLayout } from "./data-layout.js";

/** 生命周期只清理显式目标：重置删除会话正文，删除智能体才清理其私有文件。 */
export const createAgentStorage = (layout: DataLayout): AgentStorage => ({
  exists: async (id) => {
    try { return (await stat(agentSessionsDir(layout, id))).isDirectory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  },
  clearSessions: async (id) => {
    const directory = agentSessionsDir(layout, id);
    let files: string[];
    try { files = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const file of files) if (file.endsWith(".jsonl")) await rm(join(directory, file));
  },
  remove: async (id) => {
    await rm(agentSessionsDir(layout, id), { recursive: true, force: true });
    await rm(agentWorkspaceDir(layout, id), { recursive: true, force: true });
  },
});
