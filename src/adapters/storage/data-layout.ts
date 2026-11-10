import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isCompanionPackId } from "../../features/companions/types.js";
export { isCompanionPackId } from "../../features/companions/types.js";
import { isSessionId } from "../../features/conversation/session-id.js";
export { isSessionId } from "../../features/conversation/session-id.js";

/** 路径唯一声明；新布局不读取、转换或删除旧实例数据。 */
export type DataLayout = {
  root: string; companionsDir: string; profileDir: string; workspaceDir: string; sessionsDir: string; sessionIndexFile: string;
  messageFeedbackDir: string; informationDir: string; agentDir: string; piAuthFile: string;
  memoryFile: string; jobsFile: string; goalsFile: string; actionsFile: string; monitorsFile: string; newsFile: string;
  soulFile: string; userFile: string; dreamFile: string; authKeyFile: string;
  browserProfileDir: string; browserDownloadsDir: string; skillsDir: string; subagentsDir: string; tracesDir: string;
};
export const createDataLayout = (dataDir: string): DataLayout => {
  const root = resolve(dataDir);
  const profileDir = join(root, "profile");
  return {
    root, companionsDir: join(root, "companions"), profileDir, workspaceDir: join(root, "workspace"), sessionsDir: join(root, "sessions"),
    sessionIndexFile: join(root, "sessions.json"), messageFeedbackDir: join(root, "messages"),
    informationDir: join(root, "information"), agentDir: join(root, "agent"), piAuthFile: join(root, "agent", "auth.json"),
    memoryFile: join(profileDir, "memory.json"), jobsFile: join(root, "jobs.json"), goalsFile: join(root, "goals.json"),
    actionsFile: join(root, "actions.json"), monitorsFile: join(root, "monitors.json"), newsFile: join(root, "news.json"),
    soulFile: join(profileDir, "SOUL.md"), userFile: join(profileDir, "USER.md"), dreamFile: join(profileDir, "DREAM.md"),
    authKeyFile: join(root, "auth.key"), browserProfileDir: join(root, "browser", "profile"),
    browserDownloadsDir: join(root, "browser", "downloads"), skillsDir: join(root, "skills"),
    subagentsDir: join(root, "subagents"), tracesDir: join(root, "traces"),
  };
};
export const companionPackDir = (layout: DataLayout, packId: string): string => {
  if (!isCompanionPackId(packId)) throw new Error("Invalid companion pack ID");
  return join(layout.companionsDir, packId);
};
export const sessionDir = (layout: DataLayout, sessionId: string): string => {
  if (!isSessionId(sessionId)) throw new Error("Invalid sessionId");
  return join(layout.sessionsDir, sessionId);
};
export const sessionInstructionsFile = (layout: DataLayout, sessionId: string): string => join(sessionDir(layout, sessionId), "INSTRUCTIONS.md");
export const sessionSkillsFile = (layout: DataLayout, sessionId: string): string => join(sessionDir(layout, sessionId), "skills.json");
export const messageFeedbackFile = (layout: DataLayout, sessionId: string, piSessionId: string): string => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(piSessionId)) throw new Error("Invalid piSessionId");
  sessionDir(layout, sessionId);
  return join(layout.messageFeedbackDir, sessionId, `${piSessionId}.json`);
};
export const informationFile = (layout: DataLayout): string => join(layout.informationDir, "sms.json");

/** 初始化也拒绝链接，不能让 mkdir 跟随替换后的边界根。 */
export const ensureLayout = async (layout: DataLayout): Promise<void> => {
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  for (const directory of [layout.root, layout.companionsDir, layout.profileDir, layout.workspaceDir, layout.sessionsDir, layout.messageFeedbackDir, layout.informationDir, layout.agentDir]) {
    try {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe data directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(directory, { mode: 0o700 });
    }
  }
};
