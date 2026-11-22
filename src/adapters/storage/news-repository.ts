import { lstat } from "node:fs/promises";
import type { NewsRepository } from "../../features/news/types.js";
import {
  applyNewsState,
  ensureNewsSchema,
  type NewsRepositoryHandle,
  parseNewsState,
  readNewsState,
} from "./news-schema.js";
import { openSqliteDatabase } from "./sqlite-database.js";

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

export const createNewsRepository = (database: NewsRepositoryHandle["database"]): NewsRepository => ({
  read: () => database.serialize(() => readNewsState(database)),
  update: (change) => database.serialize(async () => {
    const current = readNewsState(database);
    // 回调允许原位修改；diff 基线必须与回调持有的对象隔离。
    const changed = await change(structuredClone(current));
    if (changed.state) {
      const next = parseNewsState(changed.state);
      database.transaction(() => applyNewsState(database, current, next));
    }
    return changed.result;
  }),
  validate: () => database.serialize(() => {
    readNewsState(database);
  }),
  hasPendingArticle: () => database.serialize(() =>
    Boolean(database.database.prepare("SELECT 1 FROM news_articles WHERE status = 'pending' LIMIT 1").get()),
  ),
  reconcileOnStart: () => database.serialize(() => {
    const current = readNewsState(database);
    const hasRunning = current.processing.runs.some((run) => run.status === "running");
    const hasProcessing = current.processing.items.some((item) => item.status === "processing");
    if (!hasRunning && !hasProcessing) return;
    const now = new Date().toISOString();
    const next = parseNewsState({
      ...current,
      processing: {
        ...current.processing,
        items: current.processing.items.map((item) => {
          if (item.status !== "processing") return item;
          const { runId: _drop, ...rest } = item;
          return { ...rest, status: "pending" as const };
        }),
        runs: current.processing.runs.map((run) =>
          run.status === "running"
            ? {
                ...run,
                status: "failed" as const,
                finishedAt: now,
                model: { status: "failed" as const, error: "Service restarted while screening was running" },
              }
            : run),
      },
    });
    database.transaction(() => applyNewsState(database, current, next));
  }),
});

/**
 * 打开（或初始化）news.sqlite 并返回共享 Managed 实例上的仓储。
 * 后续 AgentSQL 工具必须复用同一 Managed 实例，不另开 writer。
 */
export const openNewsRepository = async (options: {
  databaseFile: string;
}): Promise<NewsRepositoryHandle> => {
  const databaseExists = await fileExists(options.databaseFile);
  const database = await openSqliteDatabase(options.databaseFile);
  try {
    await database.serialize(() => ensureNewsSchema(database, !databaseExists));
    return { repository: createNewsRepository(database), database };
  } catch (error) {
    // 打开/建库失败必须释放连接，不留半初始化资源。
    await database.close().catch(() => undefined);
    throw error;
  }
};
