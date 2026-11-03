import { lstat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isAgentId } from "../../features/conversation/agent-id.js";

/**
 * 统一描述个人助手的数据文件布局。
 *
 * 业务代码通过这里读取当前布局，不在启动过程中隐式迁移文件。
 */
export type DataLayout = {
  root: string;
  profileDir: string;
  workspaceDir: string;
  sessionsDir: string;
  messageFeedbackDir: string;
  informationDir: string;
  agentDir: string;
  piAuthFile: string;
  memoryFile: string;
  jobsFile: string;
  goalsFile: string;
  actionsFile: string;
  monitorsFile: string;
  newsFile: string;
  soulFile: string;
  userFile: string;
  dreamFile: string;
  authKeyFile: string;
  browserProfileDir: string;
  browserDownloadsDir: string;
  skillsDir: string;
  subagentsDir: string;
};

export const createDataLayout = (dataDir: string): DataLayout => {
  const root = resolve(dataDir);
  const profileDir = join(root, "profile");
  return {
    root,
    profileDir,
    workspaceDir: join(root, "workspace"),
    sessionsDir: join(root, "sessions"),
    messageFeedbackDir: join(root, "messages"),
    informationDir: join(root, "information"),
    agentDir: join(root, "agent"),
    piAuthFile: join(root, "agent", "auth.json"),
    memoryFile: join(profileDir, "memory.json"),
    jobsFile: join(root, "jobs.json"),
    goalsFile: join(root, "goals.json"),
    actionsFile: join(root, "actions.json"),
    monitorsFile: join(root, "monitors.json"),
    newsFile: join(root, "news.json"),
    soulFile: join(profileDir, "SOUL.md"),
    userFile: join(profileDir, "USER.md"),
    dreamFile: join(profileDir, "DREAM.md"),
    authKeyFile: join(root, "auth.key"),
    browserProfileDir: join(root, "browser", "profile"),
    browserDownloadsDir: join(root, "browser", "downloads"),
    skillsDir: join(root, "skills"),
    subagentsDir: join(root, "subagents"),
  };
};

/** 旧布局不参与运行时读取；必须先停服显式转换，不能悄悄创建一套空工作区。 */
export const assertAgentDataLayout = async (layout: DataLayout) => {
  try {
    await lstat(join(layout.workspaceDir, "threads"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Legacy Space data layout detected. Stop the service and explicitly convert a backup before starting the Agent version; no data was migrated.");
};

/** 单 owner 多会话：每个 agent 独占 sessions/<agentId>/ 下的 pi 会话树。 */
export const agentSessionsDir = (layout: DataLayout, agentId: string) =>
  join(layout.sessionsDir, agentId);

/** 跨智能体讨论归目标智能体所有；与该智能体主聊天的 JSONL 分开，reset/delete 一并清理。 */
export const agentDiscussionsDir = (layout: DataLayout, agentId: string) => {
  if (!isAgentId(agentId)) throw new Error("Invalid agentId");
  return join(agentSessionsDir(layout, agentId), "discussions");
};
export const agentDiscussionDir = (layout: DataLayout, agentId: string, discussionId: string) => {
  if (!/^[a-f0-9-]{36}$/.test(discussionId)) throw new Error("Invalid discussionId");
  return join(agentDiscussionsDir(layout, agentId), discussionId);
};

/** 反馈按智能体和 PI session 双重隔离；reset 后旧 session 文件不再可寻址。 */
export const messageFeedbackFile = (layout: DataLayout, agentId: string, sessionId: string): string => {
  if (!isAgentId(agentId)) throw new Error("Invalid agentId");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid sessionId");
  return join(layout.messageFeedbackDir, agentId, `${sessionId}.json`);
};

/** 每个会话的技能覆盖文件：sessions/<agentId>/skills.json */
export const agentSkillsFile = (layout: DataLayout, agentId: string) =>
  join(agentSessionsDir(layout, agentId), "skills.json");

/** 每个会话的专属指令文件：sessions/<agentId>/INSTRUCTIONS.md */
export const agentInstructionsFile = (layout: DataLayout, agentId: string) =>
  join(agentSessionsDir(layout, agentId), "INSTRUCTIONS.md");

/** 每个会话的 Dream 补充提示词：sessions/<agentId>/DREAM.md */
export const agentDreamPromptFile = (layout: DataLayout, agentId: string) =>
  join(agentSessionsDir(layout, agentId), "DREAM.md");

/** 每个会话的 Dream 状态文件：sessions/<agentId>/dream.json */
export const agentDreamFile = (layout: DataLayout, agentId: string) =>
  join(agentSessionsDir(layout, agentId), "dream.json");

/** 信息接入域独立于 PI 会话；reset 保留，delete 级联删除。 */
export const agentInformationFile = (layout: DataLayout, agentId: string): string => {
  if (!isAgentId(agentId)) throw new Error("Invalid agentId");
  return join(layout.informationDir, `${agentId}.json`);
};

/** workspace/ 与 agents/ 仅为容器；智能体与内部任务没有父目录访问特权。 */
export const agentWorkspaceDir = (layout: DataLayout, agentId: string) => {
  if (!isAgentId(agentId)) throw new Error("Invalid agentId");
  return join(layout.workspaceDir, "agents", agentId);
};

/** 所有会话通过 shared/ 别名显式访问的共享目录，不在私有目录内建立链接。 */
export const sharedWorkspaceDir = (layout: DataLayout) =>
  join(layout.workspaceDir, "shared");

const ensureWorkspaceDirectory = async (directory: string) => {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe workspace directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { mode: 0o700 });
  }
};

/** 只初始化新布局，不读取、搬移或删除原 workspace 根目录下的旧文件。 */
export const ensureAgentLayout = async (layout: DataLayout) => {
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  await mkdir(layout.profileDir, { recursive: true, mode: 0o700 });
  await mkdir(layout.sessionsDir, { recursive: true, mode: 0o700 });
  await ensureWorkspaceDirectory(layout.workspaceDir);
  await ensureWorkspaceDirectory(join(layout.workspaceDir, "agents"));
  await ensureWorkspaceDirectory(sharedWorkspaceDir(layout));
  await ensureWorkspaceDirectory(agentWorkspaceDir(layout, "local-main"));
};

/** 从容器到私有根逐级拒绝链接，避免初始化本身跟随链接替其他智能体创建目录。 */
export const ensureAgentWorkspace = async (layout: DataLayout, agentId: string) => {
  const directory = agentWorkspaceDir(layout, agentId);
  await ensureWorkspaceDirectory(layout.workspaceDir);
  await ensureWorkspaceDirectory(join(layout.workspaceDir, "agents"));
  await ensureWorkspaceDirectory(sharedWorkspaceDir(layout));
  await ensureWorkspaceDirectory(directory);
};
