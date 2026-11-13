import type { ManagedSqliteDatabase } from "./sqlite-database.js";

/**
 * main.sqlite 的模块化结构与迁移账本。
 *
 * 为什么不用 PRAGMA user_version：新闻库 news.sqlite 是独立数据库，独占自己的
 * user_version；main.sqlite 要容纳多个业务模块，一个全局版本号无法表达
 * “jobs 已升级、sms 还没升级”。因此 main 使用按模块登记的账本。
 *
 * 规则：
 * - 一个模块的表只有在该模块在账本里登记后才允许存在；已有库缺表或版本不符
 *   明确失败，不静默补默认值、不整库重建。
 * - 新建空库时按注册顺序建立全部模块结构，并一次登记。
 * - 模块版本变化必须由代码显式提供新 DDL；本文件不提供自动迁移脚本，
 *   也不允许“自动升级”后丢失用户数据。
 */
export type SqliteModule = {
  /** 稳定模块标识，同时是账本主键与表名前缀来源。 */
  id: string;
  /** 该模块当前结构版本。 */
  version: number;
  /** 该模块拥有的表；用于校验库结构与模块一致。 */
  tables: readonly string[];
  /** 建表语句；只允许 CREATE TABLE/INDEX，语句必须可重复执行。 */
  ddl: readonly string[];
};

export const SQLITE_MODULE_LEDGER_TABLE = "app_schema_migrations";

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${SQLITE_MODULE_LEDGER_TABLE} (
  module TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
)`;

const tableExists = (database: ManagedSqliteDatabase["database"], table: string): boolean =>
  Boolean(database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));

const readLedger = (managed: ManagedSqliteDatabase): Map<string, number> => {
  const rows = managed.database.prepare(`SELECT module, version FROM ${SQLITE_MODULE_LEDGER_TABLE}`).all() as Array<{ module: string; version: number }>;
  return new Map(rows.map((row) => [row.module, row.version]));
};

/**
 * 建立或校验模块结构。
 * - 空库（无任何用户表）时建立全部模块并登记。
 * - 已有库：账本里已登记的模块必须表齐全且版本一致；未登记但表已存在的模块
 *   视为结构损坏并失败，不接管、不覆盖。
 */
export const ensureSqliteModules = (
  managed: ManagedSqliteDatabase,
  modules: readonly SqliteModule[],
): void => {
  managed.transaction(() => {
    const database = managed.database;
    database.exec(LEDGER_DDL);
    const registered = readLedger(managed);
    const declared = new Map(modules.map((module) => [module.id, module]));
    for (const [id, version] of registered) {
      const module = declared.get(id);
      if (!module) throw new Error(`Invalid main database: unknown module ${id}`);
      if (version !== module.version) {
        throw new Error(`Invalid main database: module ${id} has version ${version}, expected ${module.version}`);
      }
      for (const table of module.tables) {
        if (!tableExists(database, table)) {
          throw new Error(`Invalid main database: module ${id} is missing table ${table}`);
        }
      }
    }
    for (const module of modules) {
      const version = registered.get(module.id);
      if (version !== undefined) continue;
      for (const table of module.tables) {
        if (tableExists(database, table)) {
          throw new Error(`Invalid main database: table ${table} exists without module ${module.id}`);
        }
      }
      for (const statement of module.ddl) database.exec(statement);
      database.prepare(`INSERT INTO ${SQLITE_MODULE_LEDGER_TABLE} (module, version, applied_at) VALUES (?, ?, ?)`)
        .run(module.id, module.version, new Date().toISOString());
    }
  });
};
