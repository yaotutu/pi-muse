import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ensureLayout, sessionHistoryDir, type DataLayout } from "../storage/data-layout.js";
import type { ConversationHistoryPort } from "../../features/conversation/ports.js";
import { AGENT_STATUS_ENTRY_TYPE, RESULT_ENTRY_TYPE, TURN_ENTRY_TYPE, type ConversationTurn } from "../../features/conversation/types.js";
import { isMeaningfulExecutionRun, type SessionStatus } from "../../features/workspace/session-status.js";
import { createNotificationMessage, notificationIdOf } from "./notification-message.js";
import { collectConversationRecords, projectConversationHistory, projectDreamTranscript, projectMessageFacts } from "./history-projection.js";
import type { ToolPresentation } from "../ag-ui/tool-presentation.js";

const normalizeSessionStatus = (raw: SessionStatus & { activityId?: unknown }): SessionStatus => {
  const { activityId: _legacyActivityId, steps, ...rest } = raw as SessionStatus & { activityId?: unknown; steps?: unknown };
  return {
    ...rest,
    steps: Array.isArray(steps) ? steps : [],
  };
};

const turnIndex = (branch: readonly SessionEntry[], runId: string) =>
  branch.findLastIndex((entry) =>
    entry.type === "custom" && entry.customType === TURN_ENTRY_TYPE &&
    (entry.data as ConversationTurn).runId === runId,
  );

const hasSessionFile = async (dir: string): Promise<boolean> => {
  try {
    return (await readdir(dir)).some((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/**
 * pi entry tree 是历史唯一事实来源。
 * 展示读取完整 branch（不读压缩后的 model context）；重试只追加 context edit。
 */
export const createSessionHistory = async (
  layout: DataLayout,
  sessionId: string,
  presentation?: ToolPresentation,
  initialPiSessionId?: string,
) => {
  const sessionsDir = sessionHistoryDir(layout, sessionId);
  const cwd = layout.workspaceDir;
  await ensureLayout(layout);
  await Promise.all(
    [sessionsDir, layout.agentDir].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  // 已有 JSONL 时按 cwd 继续最近会话；无 JSONL 时使用给定 piSessionId 初始化。
  const manager = (await hasSessionFile(sessionsDir))
    ? SessionManager.continueRecent(cwd, sessionsDir)
    : SessionManager.create(cwd, sessionsDir, initialPiSessionId ? { id: initialPiSessionId } : undefined);
  const history: ConversationHistoryPort = {
    piSessionId: () => manager.getSessionId(),
    history: () => {
      const projected = projectConversationHistory(manager.getBranch());
      return presentation ? presentation.presentHistory(projected) : projected;
    },
    messageFacts: () => projectMessageFacts(manager.getBranch()),
    records: () => collectConversationRecords(manager.getBranch()),
    appendAgentStatus: (status) => { manager.appendCustomEntry(AGENT_STATUS_ENTRY_TYPE, status); },
    sessionStatuses: () => manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === AGENT_STATUS_ENTRY_TYPE)
      .map((entry) => normalizeSessionStatus((entry as { data: SessionStatus }).data)),
    checkpoint: () => manager.getLeafId(),
    appendTurn: (turn) => { manager.appendCustomEntry(TURN_ENTRY_TYPE, turn); },
    appendNotification: (notification) => {
      const checkpoint = manager.getLeafId();
      try {
        manager.appendMessage(createNotificationMessage(notification));
      } catch (error) {
        // pi 先更新内存树再写文件；写入失败不能让内存投影假装投递成功。
        if (checkpoint) manager.branch(checkpoint);
        else manager.resetLeaf();
        throw error;
      }
    },
    appendResult: (result) => { manager.appendCustomEntry(RESULT_ENTRY_TYPE, result); },
    omitTurn: (runId) => {
      const branch = manager.getBranch();
      for (const entry of branch.slice(turnIndex(branch, runId) + 1)) {
        // 独立任务/监控事实不属于被重试的模型轮，不能跟随旧回复一并隐藏。
        if (entry.type === "message" &&
          (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult") &&
          !(entry.message.role === "assistant" && notificationIdOf(entry.message)))
          manager.appendContextEdit(entry.id, null);
      }
    },
    restoreIfNoUser: (runId, checkpoint) => {
      const branch = manager.getBranch();
      const hasUser = branch.slice(turnIndex(branch, runId) + 1)
        .some((entry) => entry.type === "message" && entry.message.role === "user");
      if (hasUser) return;
      // 保留新追加的审计条目，但恢复旧叶子，不能让前置失败抹掉原历史。
      if (checkpoint) manager.branch(checkpoint);
      else manager.resetLeaf();
    },
  };
  // manager 只提供给同一 pi adapter 的执行装配，不暴露到 feature 或协议层。
  return { manager, history };
};

/**
 * 只读读取指定会话的 pi 权威历史供 Dream 整理使用：
 * 若会话目录不存在或尚无 JSONL 文件，直接返回空结果，绝不创建目录或复活已删会话。
 */
export const readDreamTranscript = async (
  layout: DataLayout,
  sessionId: string,
) => {
  const sessionsDir = sessionHistoryDir(layout, sessionId);
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { messages: [] };
    }
    throw error;
  }
  if (!files.length) return { messages: [] };
  const manager = SessionManager.continueRecent(
    layout.workspaceDir,
    sessionsDir,
  );
  return projectDreamTranscript(manager.getBranch());
};

const isJunkAgentStatusEntry = (entry: Record<string, unknown>): boolean => {
  if (entry.type !== "custom" || entry.customType !== AGENT_STATUS_ENTRY_TYPE) return false;
  const raw = entry.data;
  if (!raw || typeof raw !== "object") return true;
  const normalized = normalizeSessionStatus(raw as SessionStatus & { activityId?: unknown });
  if (normalized.title === "正在处理请求" && normalized.steps.length === 0) return true;
  return !isMeaningfulExecutionRun(normalized);
};

/**
 * 物理删除单个会话 JSONL 中无意义的旧占位/纯文字问答运行记录，
 * 并把原本挂在其后的子条目 parentId 安全重接到上游有效父节点，保证会话树不断裂。
 */
export const pruneJunkAgentStatusFromJsonlFile = async (
  filePath: string,
): Promise<{ removed: number; kept: number }> => {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const removedParent = new Map<string, string | null>();
  const keptEntries: Record<string, unknown>[] = [];
  for (const entry of parsed) {
    if (isJunkAgentStatusEntry(entry) && typeof entry.id === "string") {
      removedParent.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
    } else {
      keptEntries.push(entry);
    }
  }
  if (!removedParent.size) return { removed: 0, kept: keptEntries.length };

  for (const entry of keptEntries) {
    for (const [key, value] of Object.entries(entry)) {
      if (key !== "parentId" && typeof value === "string" && removedParent.has(value)) {
        throw new Error(`Refusing to prune ${value} in ${filePath}: referenced by ${key}`);
      }
    }
    let parentId = typeof entry.parentId === "string" ? entry.parentId : null;
    while (parentId && removedParent.has(parentId)) {
      parentId = removedParent.get(parentId) ?? null;
    }
    if ("parentId" in entry) entry.parentId = parentId;
  }

  const nextContent = `${keptEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const tmpPath = `${filePath}.prune-${process.pid}.tmp`;
  const info = await stat(filePath).catch(() => null);
  await writeFile(tmpPath, nextContent, { encoding: "utf8", mode: info ? info.mode & 0o777 : 0o600 });
  await rename(tmpPath, filePath);
  return { removed: removedParent.size, kept: keptEntries.length };
};

/** 扫描指定数据目录下的全部会话 JSONL，物理清理无意义旧运行记录。 */
export const pruneJunkAgentStatusInDataDir = async (
  dataDir: string,
): Promise<{ filesProcessed: number; filesModified: number; totalRemoved: number }> => {
  const sessionsRoot = join(dataDir, "sessions");
  let sessionDirs: string[] = [];
  try {
    sessionDirs = await readdir(sessionsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { filesProcessed: 0, filesModified: 0, totalRemoved: 0 };
    }
    throw error;
  }
  let filesProcessed = 0;
  let filesModified = 0;
  let totalRemoved = 0;
  for (const sessionDir of sessionDirs) {
    const historyDir = join(sessionsRoot, sessionDir, "history");
    let names: string[];
    try {
      names = (await readdir(historyDir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      filesProcessed++;
      const result = await pruneJunkAgentStatusFromJsonlFile(join(historyDir, name));
      if (result.removed > 0) {
        filesModified++;
        totalRemoved += result.removed;
      }
    }
  }
  return { filesProcessed, filesModified, totalRemoved };
};
