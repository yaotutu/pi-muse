import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { NewsRepository } from "../../features/news/types.js";
import {
  applyNewsState,
  ensureNewsSchema,
  type NewsRepositoryHandle,
  parseNewsState,
  readNewsOrigin,
  readNewsState,
} from "./news-schema.js";
import { openSqliteDatabase } from "./sqlite-database.js";

/**
 * 新闻仓储的 SQLite 实现：聚合 read/update 接口保持共享业务算法不变，
 * 写入按行级 diff 提交（见 news-schema.ts）。
 *
 * 旧 news.json 只作为“是否需要显式导入”的检测源，运行时绝不写回；
 * 发现任何旧文档而没有已导入库时启动必须失败并说明导入入口，
 * 不忽略、不置空、不做启动期隐式迁移。
 */
export class LegacyNewsImportRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyNewsImportRequiredError";
  }
}

const IMPORT_HINT = "Run: node --import tsx scripts/import-news-sqlite.ts --source <news.json> --target <news.sqlite>";

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** 旧文档只检查存在性，不读正文；真正的校验只在显式导入入口执行。 */
const legacyNewsExists = async (file: string): Promise<boolean> => {
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Unsafe legacy news document");
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
});

/**
 * 打开（或初始化）news.sqlite 并返回共享 Managed 实例上的仓储。
 * 后续 AgentSQL 工具必须复用同一 Managed 实例，不另开 writer。
 */
export const openNewsRepository = async (options: {
  databaseFile: string;
  legacyJsonFile: string;
}): Promise<NewsRepositoryHandle> => {
  const legacy = await legacyNewsExists(options.legacyJsonFile);
  const databaseExists = await fileExists(options.databaseFile);
  if (!databaseExists && legacy) {
    throw new LegacyNewsImportRequiredError(
      `Legacy news document exists but no news database exists (${options.legacyJsonFile}); explicit import is required. ${IMPORT_HINT}`,
    );
  }
  const database = await openSqliteDatabase(options.databaseFile);
  try {
    await database.serialize(() => ensureNewsSchema(database, { origin: "service" }, !databaseExists));
    const origin = await database.serialize(() => readNewsOrigin(database));
    if (legacy && (origin.origin !== "imported" || origin.importedFrom !== resolve(options.legacyJsonFile))) {
      throw new LegacyNewsImportRequiredError(
        `Legacy news document coexists with a service-initialized news database (${options.legacyJsonFile}); refusing to silently mix. Import explicitly into a fresh database or remove the legacy file after confirming it is no longer needed. ${IMPORT_HINT}`,
      );
    }
    return { repository: createNewsRepository(database), database };
  } catch (error) {
    // 打开/建库失败必须释放连接，不留半初始化资源。
    await database.close().catch(() => undefined);
    throw error;
  }
};
