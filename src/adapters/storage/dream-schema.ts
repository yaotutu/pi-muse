import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import { SQLITE_MODULE_LEDGER_TABLE, type SqliteModule } from "./sqlite-modules.js";
import { canonicalJson } from "./sms-schema.js";
import { InvalidDocumentError } from "./document-schemas.js";
import {
  defaultDreamState,
  type DreamPending,
  type DreamRun,
  type DreamState,
} from "../../features/dream/types.js";

/**
 * Dream 状态形状校验：开关、游标、最近运行与待决项必须是合法形状。
 * 库内读回的聚合同样走这条校验，坏数据整体拒绝，不静默过滤、不补默认值。
 */
export const parseDreamState = (value: unknown): DreamState => {
  const targets = ["user", "soul", "instructions", "memory"];
  const runStatuses = ["running", "completed", "failed", "partial"];
  const reasons = ["ambiguous", "global_from_session", "no_purpose"];
  const allowedRoot = new Set(["enabled", "cursors", "lastRun", "pending"]);
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    "schemaVersion" in (value as Record<string, unknown>) ||
    Object.keys(value as Record<string, unknown>).some((key) => !allowedRoot.has(key)) ||
    typeof (value as Record<string, unknown>).enabled !== "boolean" ||
    !(value as Record<string, unknown>).cursors ||
    typeof (value as Record<string, unknown>).cursors !== "object" ||
    !Object.entries((value as Record<string, unknown>).cursors as Record<string, unknown>).every(([id, cursor]) =>
      (id === "main" || /^[a-f0-9-]{36}$/.test(id)) && typeof cursor === "string" && cursor.length > 0) ||
    !Array.isArray((value as Record<string, unknown>).pending)
  ) {
    throw new InvalidDocumentError("dream");
  }
  const state = value as Record<string, unknown>;
  if (state.lastRun !== undefined) {
    const run = state.lastRun as Record<string, unknown>;
    const allowedRun = new Set(["at", "status", "changed", "processed", "error"]);
    if (
      !run || typeof run !== "object" || Array.isArray(run) ||
      Object.keys(run).some((key) => !allowedRun.has(key)) ||
      typeof run.at !== "string" || !Number.isFinite(Date.parse(run.at)) ||
      typeof run.status !== "string" || !runStatuses.includes(run.status) ||
      !Array.isArray(run.changed) ||
      !run.changed.every((item) => typeof item === "string" && targets.includes(item)) ||
      typeof run.processed !== "number" || !Number.isInteger(run.processed) || run.processed < 0 ||
      (run.error !== undefined && typeof run.error !== "string")
    ) {
      throw new InvalidDocumentError("dream");
    }
  }
  const allowedPending = new Set(["id", "text", "suggestedTarget", "reason", "createdAt", "sourceSessionId"]);
  if (
    !(state.pending as unknown[]).every((item) => {
      const pending = item as Record<string, unknown>;
      return pending && typeof pending === "object" && !Array.isArray(pending) &&
        Object.keys(pending).every((key) => allowedPending.has(key)) &&
        typeof pending.id === "string" && pending.id.length > 0 &&
        typeof pending.text === "string" && pending.text.length > 0 &&
        typeof pending.suggestedTarget === "string" && targets.includes(pending.suggestedTarget) &&
        typeof pending.reason === "string" && reasons.includes(pending.reason) &&
        typeof pending.createdAt === "string" && Number.isFinite(Date.parse(pending.createdAt));
    })
  ) {
    throw new InvalidDocumentError("dream");
  }
  return value as DreamState;
};

/**
 * Dream 机器状态在 main.sqlite 的表结构与行映射。
 *
 * owner 边界：Dream 是实例全局服务，状态与待决项都存在这里；提示文本仍由
 * profile/DREAM.md 承载（文件事实不迁库），本模块只保存开关、游标、最近运行
 * 与待确认建议。
 *
 * 设计要点：
 * - dream_state 是单例：开关与最近一次整理轮；lastRun 形状随领域演进，
 *   用规范 JSON 列保真，不拆成会漂移的散列。
 * - dream_cursors 按来源会话保存游标，保留插入顺序。
 * - dream_pending 按行保存待确认建议，保留顺序与来源会话。
 */
const DREAM_SCHEMA_VERSION = 1;

const DREAM_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS dream_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    last_run_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS dream_cursors (
    session_id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    cursor TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS dream_pending (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    suggested_target TEXT NOT NULL CHECK (suggested_target IN ('user', 'soul', 'instructions', 'memory')),
    reason TEXT NOT NULL CHECK (reason IN ('ambiguous', 'global_from_session', 'no_purpose')),
    created_at TEXT NOT NULL,
    source_session_id TEXT
  )`,
] as const;

const DREAM_TABLES = ["dream_state", "dream_cursors", "dream_pending"] as const;

/**
 * Dream 模块登记信息。模块 id 与表名前缀一致，主会话的模块注册表按此登记到
 * main.sqlite 的迁移账本。
 */
export const dreamModule: SqliteModule = {
  id: "dream",
  version: DREAM_SCHEMA_VERSION,
  tables: DREAM_TABLES,
  ddl: DREAM_TABLE_DDL,
};

const tableExists = (managed: ManagedSqliteDatabase, table: string): boolean =>
  Boolean(managed.database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));

const insertDefaultDreamState = (managed: ManagedSqliteDatabase): void => {
  const state = defaultDreamState();
  managed.database.prepare("INSERT INTO dream_state (id, enabled, last_run_json) VALUES (1, ?, NULL)")
    .run(state.enabled ? 1 : 0);
};

/**
 * 结构校验与默认状态初始化：模块必须已登记且版本一致；状态单例缺失时，
 * 只有在其他 dream 表也没有数据的情况下才写默认值，已用过的模块丢状态行
 * 视为结构损坏并显式失败。
 */
export const ensureDreamModule = (managed: ManagedSqliteDatabase): void => {
  if (!tableExists(managed, SQLITE_MODULE_LEDGER_TABLE)) {
    throw new Error("Invalid main database: missing schema ledger; ensureSqliteModules must run before the Dream repository is created");
  }
  const registered = managed.database
    .prepare(`SELECT version FROM ${SQLITE_MODULE_LEDGER_TABLE} WHERE module = ?`)
    .get("dream") as { version: number } | undefined;
  if (!registered) throw new Error("Invalid main database: module dream is not registered");
  if (registered.version !== DREAM_SCHEMA_VERSION) {
    throw new Error(`Invalid main database: module dream has version ${registered.version}, expected ${DREAM_SCHEMA_VERSION}`);
  }
  for (const table of DREAM_TABLES) {
    if (!tableExists(managed, table)) {
      throw new Error(`Invalid main database: module dream is missing table ${table}`);
    }
  }
  if (managed.database.prepare("SELECT 1 FROM dream_state WHERE id = 1").get()) return;
  for (const table of ["dream_cursors", "dream_pending"]) {
    if (managed.database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error("Invalid main database: missing dream_state row");
    }
  }
  insertDefaultDreamState(managed);
};

type StateRow = { enabled: number; last_run_json: string | null };
type CursorRow = { session_id: string; position: number; cursor: string };
type PendingRow = {
  id: string; position: number; text: string;
  suggested_target: DreamPending["suggestedTarget"];
  reason: DreamPending["reason"];
  created_at: string; source_session_id: string | null;
};

const parseLastRun = (raw: string | null): DreamRun | undefined => {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as DreamRun;
  } catch {
    throw new InvalidDocumentError("dream");
  }
};

/** 从显式列装配完整 DreamState 聚合，并沿用既有文档校验规则。 */
export const readDreamState = (managed: ManagedSqliteDatabase): DreamState => {
  const database = managed.database;
  const stateRow = database.prepare("SELECT enabled, last_run_json FROM dream_state WHERE id = 1").get() as StateRow | undefined;
  if (!stateRow) throw new Error("Invalid main database: missing dream_state row");

  const cursors: Record<string, string> = {};
  for (const row of database.prepare(
    "SELECT session_id, position, cursor FROM dream_cursors ORDER BY position",
  ).all() as CursorRow[]) {
    cursors[row.session_id] = row.cursor;
  }
  const pending = (database.prepare(
    "SELECT id, position, text, suggested_target, reason, created_at, source_session_id FROM dream_pending ORDER BY position",
  ).all() as PendingRow[]).map<DreamPending>((row) => ({
    id: row.id,
    text: row.text,
    suggestedTarget: row.suggested_target,
    reason: row.reason,
    createdAt: row.created_at,
    ...(row.source_session_id !== null ? { sourceSessionId: row.source_session_id } : {}),
  }));
  const lastRun = parseLastRun(stateRow.last_run_json);
  return parseDreamState({
    enabled: stateRow.enabled === 1,
    cursors,
    ...(lastRun !== undefined ? { lastRun } : {}),
    pending,
  });
};

const projectPending = (pending: DreamPending) => ({
  text: pending.text,
  suggestedTarget: pending.suggestedTarget,
  reason: pending.reason,
  createdAt: pending.createdAt,
  sourceSessionId: pending.sourceSessionId ?? null,
});

/**
 * 行级 diff 提交：只改发生变化的行，不整表重写；删除顺序先子后父
 * （游标与待决项互不引用，先删后写即可）。
 */
export const applyDreamState = (
  managed: ManagedSqliteDatabase,
  previous: DreamState,
  next: DreamState,
): void => {
  const database = managed.database;

  const previousRun = previous.lastRun === undefined ? null : canonicalJson(previous.lastRun);
  const nextRun = next.lastRun === undefined ? null : canonicalJson(next.lastRun);
  if (previous.enabled !== next.enabled || previousRun !== nextRun) {
    database.prepare("UPDATE dream_state SET enabled = ?, last_run_json = ? WHERE id = 1")
      .run(next.enabled ? 1 : 0, nextRun);
  }

  const previousCursors = Object.entries(previous.cursors);
  const nextCursors = Object.entries(next.cursors);
  const nextCursorIds = new Set(nextCursors.map(([sessionId]) => sessionId));
  for (const [sessionId] of previousCursors) {
    if (!nextCursorIds.has(sessionId)) {
      database.prepare("DELETE FROM dream_cursors WHERE session_id = ?").run(sessionId);
    }
  }
  nextCursors.forEach(([sessionId, cursor], index) => {
    const old = previousCursors[index];
    if (old && old[0] === sessionId && old[1] === cursor) return;
    database.prepare(
      "INSERT INTO dream_cursors (session_id, position, cursor) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET position = excluded.position, cursor = excluded.cursor",
    ).run(sessionId, index, cursor);
  });

  const previousPending = new Map(previous.pending.map((pending, index) => [pending.id, { pending, index }]));
  const nextPendingIds = new Set(next.pending.map((pending) => pending.id));
  for (const pending of previous.pending) {
    if (!nextPendingIds.has(pending.id)) {
      database.prepare("DELETE FROM dream_pending WHERE id = ?").run(pending.id);
    }
  }
  next.pending.forEach((pending, index) => {
    const old = previousPending.get(pending.id);
    if (old &&
        old.index === index &&
        canonicalJson(projectPending(old.pending)) === canonicalJson(projectPending(pending))) return;
    database.prepare(
      "INSERT INTO dream_pending (id, position, text, suggested_target, reason, created_at, source_session_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, text = excluded.text, suggested_target = excluded.suggested_target, reason = excluded.reason, created_at = excluded.created_at, source_session_id = excluded.source_session_id",
    ).run(
      pending.id,
      index,
      pending.text,
      pending.suggestedTarget,
      pending.reason,
      pending.createdAt,
      pending.sourceSessionId ?? null,
    );
  });
};
