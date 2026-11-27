import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isCompanionPackId } from "../../features/companions/types.js";
export { isCompanionPackId } from "../../features/companions/types.js";
import { isSessionId } from "../../features/conversation/session-id.js";
export { isSessionId } from "../../features/conversation/session-id.js";
import { loadPrompt } from "../prompts/loader.js";

/** 路径唯一声明；新布局不读取、转换或删除旧实例数据。 */
export type DataLayout = {
  root: string; companionsDir: string; profileDir: string; workspaceDir: string; sessionsDir: string; sessionIndexFile: string;
  assistantInstructionsFile: string; assistantSkillOverridesFile: string; assistantMcpOverridesFile: string;
  subagentMcpOverridesFile: string; subagentSettingsFile: string;
  stateDir: string; newsInstructionsFile: string; smsInstructionsFile: string; agentDir: string; piAuthFile: string;
  /** 长期记忆是给人读写的纯文本；身份设置是配置 JSON。 */
  memoryMarkdownFile: string; identityFile: string;
  /** 网页监控本次保持 JSON 文件，不迁数据库。 */
  monitorsFile: string;
  mcpConfigFile: string;
  mainDatabaseFile: string; newsDatabaseFile: string;
  soulFile: string; userFile: string; bootstrapFile: string; authKeyFile: string;
  androidUpdatesDir: string; browserProfileDir: string; browserDownloadsDir: string; skillsDir: string; tracesDir: string;
};
export const createDataLayout = (dataDir: string): DataLayout => {
  const root = resolve(dataDir);
  const workspaceDir = join(root, "workspace");
  const assistant = join(workspaceDir, "assistant");
  const sessionsDir = join(root, "sessions");
  const stateDir = join(root, "state");
  const profileDir = join(stateDir, "assistant");
  const assets = join(root, "assets");
  const runtime = join(root, "runtime");
  return {
    root, workspaceDir, sessionsDir, stateDir, profileDir,
    companionsDir: join(assets, "companions"),
    assistantInstructionsFile: join(assistant, "AGENTS.md"),
    assistantSkillOverridesFile: join(profileDir, "skill-overrides.json"),
    assistantMcpOverridesFile: join(profileDir, "mcp-overrides.json"),
    subagentMcpOverridesFile: join(stateDir, "subagent-mcp-overrides.json"),
    subagentSettingsFile: join(stateDir, "subagent-settings.json"),
    newsInstructionsFile: join(workspaceDir, "subagents", "news", "AGENTS.md"),
    smsInstructionsFile: join(workspaceDir, "subagents", "sms", "AGENTS.md"),
    sessionIndexFile: join(sessionsDir, "index.json"),
    agentDir: join(runtime, "pi"), piAuthFile: join(runtime, "auth", "pi.json"),
    memoryMarkdownFile: join(profileDir, "memory.md"), identityFile: join(profileDir, "identity.json"),
    monitorsFile: join(stateDir, "monitors.json"),
    mcpConfigFile: join(root, "mcp.json"),
    mainDatabaseFile: join(stateDir, "main.sqlite"), newsDatabaseFile: join(stateDir, "news.sqlite"),
    soulFile: join(assistant, "SOUL.md"), userFile: join(assistant, "USER.md"),
    bootstrapFile: join(assistant, "BOOTSTRAP.md"),
    authKeyFile: join(runtime, "auth", "auth.key"),
    androidUpdatesDir: join(runtime, "android-updates"),
    browserProfileDir: join(runtime, "browser", "profile"),
    browserDownloadsDir: join(runtime, "browser", "downloads"),
    skillsDir: join(assets, "skills"), tracesDir: join(runtime, "traces"),
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
export const sessionHistoryDir = (layout: DataLayout, sessionId: string): string =>
  join(sessionDir(layout, sessionId), "history");
/** 初始化也拒绝链接，不能让 mkdir 跟随替换后的边界根。 */
export const ensureLayout = async (layout: DataLayout): Promise<void> => {
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  const { root, workspaceDir } = layout;
  for (const directory of [
    root,
    workspaceDir, join(workspaceDir, "assistant"), join(workspaceDir, "subagents"),
    join(workspaceDir, "subagents", "news"), join(workspaceDir, "subagents", "sms"), join(workspaceDir, "files"),
    layout.sessionsDir, layout.stateDir, layout.profileDir,
    join(root, "assets"), layout.companionsDir, layout.skillsDir,
    join(root, "runtime"), join(root, "runtime", "auth"), layout.agentDir,
    join(root, "runtime", "browser"), layout.browserProfileDir, layout.browserDownloadsDir,
  ]) {
    try {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe data directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
  }
};

/** 列表直接展示实际文件，首次初始化为空，已有内容保持原样；全新工作区额外写入一次性 BOOTSTRAP.md。 */
export const initializeWorkspaceDocuments = async (layout: DataLayout): Promise<void> => {
  let freshSoul = false;
  let freshUser = false;
  for (const file of [
    layout.assistantInstructionsFile,
    layout.soulFile,
    layout.userFile,
    layout.newsInstructionsFile,
    layout.smsInstructionsFile,
  ]) {
    try {
      await writeFile(file, "", { flag: "wx", mode: 0o600 });
      if (file === layout.soulFile) freshSoul = true;
      if (file === layout.userFile) freshUser = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (freshSoul && freshUser) {
    try {
      await writeFile(
        layout.bootstrapFile,
        `${loadPrompt("assistant/bootstrap.md").trim()}\n`,
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
};
