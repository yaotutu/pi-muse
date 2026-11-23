import type { DatabaseSync } from "node:sqlite";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import { SQLITE_MODULE_LEDGER_TABLE, type SqliteModule } from "./sqlite-modules.js";

/**
 * main.sqlite 的通用用户习惯归纳模块（v1）：
 * - habit_domains：各领域（sms/news/assistant 等）的消费游标 seq 与最近一次归纳统计；
 * - habit_items：长期生效的结构化行为习惯条文，支持按 domain+position 保序与增删改；
 * - habit_signals：按自增 seq 严格保序的反馈热缓冲队列，归纳成功提交后才推进游标并清理已消化行。
 */
export const HABITS_SCHEMA_VERSION = 1;

const HABITS_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS habit_domains (
    domain TEXT PRIMARY KEY,
    cursor_seq INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    last_run_status TEXT CHECK (last_run_status IN ('succeeded', 'failed', 'skipped', 'cancelled')),
    last_run_processed INTEGER NOT NULL DEFAULT 0,
    last_run_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS habit_items (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('consolidated', 'manual')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (domain, position)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_habit_items_domain ON habit_items(domain, position)`,
  `CREATE TABLE IF NOT EXISTS habit_signals (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    target_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_habit_signals_domain_seq ON habit_signals(domain, seq)`,
] as const;

const HABITS_TABLES = [
  "habit_domains",
  "habit_items",
  "habit_signals",
] as const;

export const habitsModule: SqliteModule = {
  id: "habits",
  version: HABITS_SCHEMA_VERSION,
  tables: HABITS_TABLES,
  ddl: HABITS_TABLE_DDL,
};

const tableExists = (database: DatabaseSync, table: string): boolean =>
  Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

/** 校验 main.sqlite 已登记当前版本 habits 模块且 3 张习惯表完整。 */
export const ensureHabitsModule = (managed: ManagedSqliteDatabase): void => {
  if (!tableExists(managed.database, SQLITE_MODULE_LEDGER_TABLE)) {
    throw new Error(
      "Invalid main database: missing schema ledger; ensureSqliteModules must run before the habits repository is created",
    );
  }
  const registered = managed.database
    .prepare(`SELECT version FROM ${SQLITE_MODULE_LEDGER_TABLE} WHERE module = ?`)
    .get("habits") as { version: number } | undefined;
  if (!registered) throw new Error("Invalid main database: module habits is not registered");
  if (registered.version !== HABITS_SCHEMA_VERSION) {
    throw new Error(`Invalid main database: module habits has version ${registered.version}, expected ${HABITS_SCHEMA_VERSION}`);
  }
  for (const table of HABITS_TABLES) {
    if (!tableExists(managed.database, table)) {
      throw new Error(`Invalid main database: module habits is missing table ${table}`);
    }
  }
};
