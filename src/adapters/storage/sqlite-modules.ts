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
  /** 可选增量结构迁移（仅在 version < module.version 时于事务内显式执行）。 */
  migrate?: (database: ManagedSqliteDatabase["database"], fromVersion: number) => void;
};

export const SQLITE_MODULE_LEDGER_TABLE = "app_schema_migrations";
// 数据库自身的标记在账本被删后仍存在，避免把已初始化但损坏的库误当作新库。
export const MAIN_SQLITE_APPLICATION_ID = 0x504d5553; // PMUS

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
    const applicationId = Number(database.prepare("PRAGMA application_id").get()?.application_id);
    if (applicationId !== 0 && applicationId !== MAIN_SQLITE_APPLICATION_ID) {
      throw new Error("Invalid main database: unexpected application identity");
    }
    if (applicationId === MAIN_SQLITE_APPLICATION_ID && !tableExists(database, SQLITE_MODULE_LEDGER_TABLE)) {
      throw new Error("Invalid main database: missing schema ledger");
    }
    database.exec(LEDGER_DDL);
    const registered = readLedger(managed);
    // 允许调用方只声明它负责的模块；其他已注册模块必须保留，而不是误判为未知。
    for (const module of modules) {
      const version = registered.get(module.id);
      if (version === undefined) continue;
      if (version !== module.version) {
        if (module.migrate && version < module.version) {
          module.migrate(database, version);
          database.prepare(`UPDATE ${SQLITE_MODULE_LEDGER_TABLE} SET version = ?, applied_at = ? WHERE module = ?`)
            .run(module.version, new Date().toISOString(), module.id);
        } else {
          throw new Error(`Invalid main database: module ${module.id} has version ${version}, expected ${module.version}`);
        }
      }
      for (const table of module.tables) {
        if (!tableExists(database, table)) {
          throw new Error(`Invalid main database: module ${module.id} is missing table ${table}`);
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
    if (applicationId === 0) database.exec(`PRAGMA application_id = ${MAIN_SQLITE_APPLICATION_ID}`);
  });
};
