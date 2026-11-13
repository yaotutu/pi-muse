import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyNewsState,
  deepEqual,
  ensureNewsSchema,
  parseNewsState,
  readNewsState,
  NEWS_META_ORIGIN_KEY,
} from "./news-schema.js";
import { openSqliteDatabase } from "./sqlite-database.js";

/**
 * 显式导入：旧 news.json（只读）→ 全新 news.sqlite。
 * - 目标已存在一律拒绝（防覆盖）；失败删除本次创建的目标与边车，
 *   不留可被误认为导入成功的库；源文件永不修改。
 * - 导入在一个事务内完成行级写入，随后整档回读与源文档逐项核对。
 * - 返回计数报告，不包含任何文章正文或凭据。
 */
export type NewsImportCounts = {
  sources: number;
  articles: number;
  runs: number;
  runItems: number;
  decisions: number;
  feedback: number;
  comments: number;
  publications: number;
};

export type NewsImportReport = {
  sourceFile: string;
  databaseFile: string;
  counts: NewsImportCounts;
};

const removeImportTarget = async (databaseFile: string): Promise<void> => {
  await Promise.all(
    [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`].map((file) => rm(file, { force: true }).catch(() => undefined)),
  );
};

export const importLegacyNewsJson = async (options: {
  sourceFile: string;
  databaseFile: string;
}): Promise<NewsImportReport> => {
  for (const target of [options.databaseFile, `${options.databaseFile}-wal`, `${options.databaseFile}-shm`]) {
    try {
      await lstat(target);
      throw new Error(`Target database already exists; refusing to overwrite: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const source = await open(options.sourceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    if (!(await source.stat()).isFile()) throw new Error("Import source must be a regular file");
    raw = await source.readFile("utf8");
  } finally {
    await source.close();
  }
  let state;
  try {
    state = parseNewsState(JSON.parse(raw));
  } catch {
    throw new Error(`Invalid news document: ${options.sourceFile}`);
  }
  // 排他占有目标，避免检查到打开之间另一个导入者创建同名库后被覆盖。
  const reservation = await open(options.databaseFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  await reservation.close();
  let database: Awaited<ReturnType<typeof openSqliteDatabase>>;
  try {
    database = await openSqliteDatabase(options.databaseFile);
  } catch (error) {
    await removeImportTarget(options.databaseFile);
    throw error;
  }
  let report: NewsImportReport;
  try {
    await database.serialize(() => ensureNewsSchema(database, {
      origin: "imported",
      source: resolve(options.sourceFile),
      importedAt: new Date().toISOString(),
    }));
    await database.serialize(() =>
      database.transaction(() => {
        applyNewsState(database, readNewsState(database), state);
        if (!deepEqual(readNewsState(database), state)) {
          throw new Error("Import verification failed: database round-trip does not match the source document");
        }
        // 完成标记和已核对的数据同事务提交；中途崩溃的库不可被启动当成空新闻。
        const completed = database.database.prepare("UPDATE news_meta SET value = 'imported' WHERE key = ? AND value = 'importing'")
          .run(NEWS_META_ORIGIN_KEY);
        if (completed.changes !== 1) throw new Error("Import completion marker is inconsistent");
      }));
    report = {
      sourceFile: options.sourceFile,
      databaseFile: options.databaseFile,
      counts: {
        sources: state.sources.length,
        articles: state.processing.items.length,
        runs: state.processing.runs.length,
        runItems: state.processing.runs.reduce((total, run) => total + run.itemIds.length, 0),
        decisions: state.processing.runs.reduce((total, run) => total + (run.decisions?.length ?? 0), 0),
        feedback: state.processing.articleFeedback.length,
        comments: state.processing.articleFeedback.reduce((total, feedback) => total + feedback.comments.length, 0),
        publications: state.processing.runs.reduce((total, run) => total + run.publications.length, 0),
      },
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    await removeImportTarget(options.databaseFile);
    throw error;
  }
  try {
    await database.close();
  } catch (error) {
    await removeImportTarget(options.databaseFile);
    throw error;
  }
  return report;
};
