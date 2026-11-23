import type { DatabaseSync } from "node:sqlite";
import {
  defaultInformationState,
  type InformationDecision,
  type InformationItem,
  type InformationRun,
  type InformationState,
} from "../../features/information/types.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import { SQLITE_MODULE_LEDGER_TABLE, type SqliteModule } from "./sqlite-modules.js";

/**
 * 短信/信息领域在 main.sqlite 中的 SQLite 模块定义（Clean Break v3）。
 *
 * - v3 移除 sms_state.preferences_learned_notes 列；长短期用户习惯统一迁移至通用 habits 模块
 *   （habit_domains / habit_items / habit_signals），sms_state 专注运行时设置。
 * - 管理 5 张核心 sms_* 表；idx_sms_items_queue_status 支持 500ms 调度器 O(1) 判断到期。
 */
export const SMS_SCHEMA_VERSION = 3;

const SMS_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS sms_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    settings_enabled INTEGER NOT NULL CHECK (settings_enabled IN (0, 1)),
    settings_batch_window_seconds INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sms_items (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE,
    queue TEXT NOT NULL CHECK (queue IN ('realtime', 'archive')),
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    received_at TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    run_id TEXT,
    UNIQUE (source, external_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sms_items_queue_status ON sms_items(queue, status, position)`,
  `CREATE TABLE IF NOT EXISTS sms_runs (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('realtime', 'archive')),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    created_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    model_status TEXT CHECK (model_status IN ('succeeded', 'failed')),
    model_error TEXT,
    has_decisions INTEGER NOT NULL CHECK (has_decisions IN (0, 1)),
    publications_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sms_run_items (
    run_id TEXT NOT NULL REFERENCES sms_runs(id),
    position INTEGER NOT NULL,
    item_id TEXT NOT NULL REFERENCES sms_items(id),
    PRIMARY KEY (run_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS sms_decisions (
    run_id TEXT NOT NULL REFERENCES sms_runs(id),
    position INTEGER NOT NULL,
    item_id TEXT NOT NULL REFERENCES sms_items(id),
    decision TEXT NOT NULL CHECK (decision IN ('silent', 'notify')),
    reason TEXT NOT NULL,
    PRIMARY KEY (run_id, position)
  )`,
] as const;

const SMS_TABLES = [
  "sms_state",
  "sms_items",
  "sms_runs",
  "sms_run_items",
  "sms_decisions",
] as const;

export const smsModule: SqliteModule = {
  id: "sms",
  version: SMS_SCHEMA_VERSION,
  tables: SMS_TABLES,
  ddl: SMS_TABLE_DDL,
};

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const tableExists = (database: DatabaseSync, table: string): boolean =>
  Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const hasAnyRows = (database: DatabaseSync, table: string): boolean =>
  Boolean(database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());

const seedSmsState = (database: DatabaseSync): void => {
  const initial = defaultInformationState();
  database.prepare(
    "INSERT INTO sms_state (id, schema_version, settings_enabled, settings_batch_window_seconds) VALUES (1, ?, ?, ?)",
  ).run(
    initial.schemaVersion,
    initial.settings.enabled ? 1 : 0,
    initial.settings.batchWindowSeconds,
  );
};

/** 校验 main.sqlite 已通过账本登记当前版本 sms 模块并确保唯一 sms_state 单例存在。 */
export const ensureSmsModule = (managed: ManagedSqliteDatabase): void => {
  if (!tableExists(managed.database, SQLITE_MODULE_LEDGER_TABLE)) {
    throw new Error(
      "Invalid main database: missing schema ledger; ensureSqliteModules must run before the SMS repository is created",
    );
  }
  const registered = managed.database
    .prepare(`SELECT version FROM ${SQLITE_MODULE_LEDGER_TABLE} WHERE module = ?`)
    .get("sms") as { version: number } | undefined;
  if (!registered) throw new Error("Invalid main database: module sms is not registered");
  if (registered.version !== SMS_SCHEMA_VERSION) {
    throw new Error(`Invalid main database: module sms has version ${registered.version}, expected ${SMS_SCHEMA_VERSION}`);
  }
  for (const table of SMS_TABLES) {
    if (!tableExists(managed.database, table)) {
      throw new Error(`Invalid main database: module sms is missing table ${table}`);
    }
  }
  if (managed.database.prepare("SELECT 1 FROM sms_state WHERE id = 1").get()) return;
  for (const table of ["sms_items", "sms_runs", "sms_run_items", "sms_decisions"] as const) {
    if (hasAnyRows(managed.database, table)) {
      throw new Error("Invalid main database: missing sms_state row");
    }
  }
  managed.transaction(() => {
    seedSmsState(managed.database);
  });
};

type StateRow = {
  schema_version: number;
  settings_enabled: number;
  settings_batch_window_seconds: number;
};

type ItemRow = {
  id: string;
  position: number;
  queue: "realtime" | "archive";
  source: string;
  external_id: string;
  title: string | null;
  content: string;
  received_at: string;
  accepted_at: string;
  status: InformationItem["status"];
  run_id: string | null;
};

type RunRow = {
  id: string;
  position: number;
  kind: "realtime" | "archive";
  status: InformationRun["status"];
  created_at: string;
  started_at: string;
  finished_at: string | null;
  model_status: "succeeded" | "failed" | null;
  model_error: string | null;
  has_decisions: number;
  publications_json: string;
};

type RunItemRow = {
  run_id: string;
  position: number;
  item_id: string;
};

type DecisionRow = {
  run_id: string;
  position: number;
  item_id: string;
  decision: "silent" | "notify";
  reason: string;
};

const parsePublications = (raw: string): InformationRun["publications"] => {
  try {
    return JSON.parse(raw) as InformationRun["publications"];
  } catch {
    throw new Error("Invalid main database: corrupted sms run publications");
  }
};

/** O(1) SQL 检查实时队列是否存在已过批等待窗口的待处理短信，避免空闲周期全表反序列化。 */
export const readNextRealtimeDue = (managed: ManagedSqliteDatabase): boolean => {
  const state = managed.database
    .prepare("SELECT settings_enabled, settings_batch_window_seconds FROM sms_state WHERE id = 1")
    .get() as { settings_enabled: number; settings_batch_window_seconds: number } | undefined;
  if (!state || state.settings_enabled !== 1) return false;
  const firstPending = managed.database
    .prepare("SELECT accepted_at FROM sms_items WHERE queue = 'realtime' AND status = 'pending' ORDER BY position LIMIT 1")
    .get() as { accepted_at: string } | undefined;
  if (!firstPending) return false;
  const dueAt = Date.parse(firstPending.accepted_at) + state.settings_batch_window_seconds * 1000;
  return Number.isNaN(dueAt) || Date.now() >= dueAt;
};

export const readSmsState = (managed: ManagedSqliteDatabase): InformationState => {
  const database = managed.database;
  const stateRow = database.prepare(
    "SELECT schema_version, settings_enabled, settings_batch_window_seconds FROM sms_state WHERE id = 1",
  ).get() as StateRow | undefined;
  if (!stateRow) throw new Error("Invalid main database: missing sms_state row");

  const items = (database.prepare(
    "SELECT id, position, queue, source, external_id, title, content, received_at, accepted_at, status, run_id FROM sms_items ORDER BY position",
  ).all() as ItemRow[]).map<InformationItem>((row) => ({
    id: row.id,
    queue: row.queue,
    source: row.source,
    externalId: row.external_id,
    ...(row.title !== null ? { title: row.title } : {}),
    content: row.content,
    receivedAt: row.received_at,
    acceptedAt: row.accepted_at,
    status: row.status,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
  }));

  const runItemsByRun = new Map<string, string[]>();
  for (const row of database.prepare("SELECT run_id, position, item_id FROM sms_run_items ORDER BY position").all() as RunItemRow[]) {
    const list = runItemsByRun.get(row.run_id) ?? [];
    list.push(row.item_id);
    runItemsByRun.set(row.run_id, list);
  }

  const decisionsByRun = new Map<string, InformationDecision[]>();
  for (const row of database.prepare("SELECT run_id, position, item_id, decision, reason FROM sms_decisions ORDER BY position").all() as DecisionRow[]) {
    const list = decisionsByRun.get(row.run_id) ?? [];
    list.push({ itemId: row.item_id, decision: row.decision, reason: row.reason });
    decisionsByRun.set(row.run_id, list);
  }

  const runs = (database.prepare(
    "SELECT id, position, kind, status, created_at, started_at, finished_at, model_status, model_error, has_decisions, publications_json FROM sms_runs ORDER BY position",
  ).all() as RunRow[]).map<InformationRun>((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    itemIds: runItemsByRun.get(row.id) ?? [],
    ...(row.model_status !== null
      ? { model: { status: row.model_status, ...(row.model_error !== null ? { error: row.model_error } : {}) } }
      : {}),
    ...(row.has_decisions === 1 ? { decisions: decisionsByRun.get(row.id) ?? [] } : {}),
    publications: parsePublications(row.publications_json),
  }));

  return {
    schemaVersion: 3,
    settings: {
      enabled: stateRow.settings_enabled === 1,
      batchWindowSeconds: stateRow.settings_batch_window_seconds,
    },
    items,
    runs,
  };
};

const projectItem = (item: InformationItem) => ({
  id: item.id,
  queue: item.queue,
  source: item.source,
  externalId: item.externalId,
  title: item.title ?? null,
  content: item.content,
  receivedAt: item.receivedAt,
  acceptedAt: item.acceptedAt,
  status: item.status,
  runId: item.runId ?? null,
});

const projectRun = (run: InformationRun) => ({
  id: run.id,
  kind: run.kind,
  status: run.status,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt ?? null,
  modelStatus: run.model?.status ?? null,
  modelError: run.model?.error ?? null,
  hasDecisions: run.decisions !== undefined,
  publications: run.publications,
});

export const applySmsState = (
  managed: ManagedSqliteDatabase,
  previous: InformationState,
  next: InformationState,
): void => {
  const database = managed.database;
  const prevState = {
    schema_version: previous.schemaVersion,
    settings_enabled: previous.settings.enabled ? 1 : 0,
    settings_batch_window_seconds: previous.settings.batchWindowSeconds,
  };
  const nextState = {
    schema_version: next.schemaVersion,
    settings_enabled: next.settings.enabled ? 1 : 0,
    settings_batch_window_seconds: next.settings.batchWindowSeconds,
  };
  if (canonicalJson(prevState) !== canonicalJson(nextState)) {
    database.prepare(
      "UPDATE sms_state SET schema_version = ?, settings_enabled = ?, settings_batch_window_seconds = ? WHERE id = 1",
    ).run(
      nextState.schema_version,
      nextState.settings_enabled,
      nextState.settings_batch_window_seconds,
    );
  }

  const nextItemIds = new Set(next.items.map((item) => item.id));
  const nextRunIds = new Set(next.runs.map((run) => run.id));
  const removedRuns = previous.runs.filter((run) => !nextRunIds.has(run.id));
  const removedItems = previous.items.filter((item) => !nextItemIds.has(item.id));

  for (const run of removedRuns) {
    database.prepare("DELETE FROM sms_run_items WHERE run_id = ?").run(run.id);
    database.prepare("DELETE FROM sms_decisions WHERE run_id = ?").run(run.id);
  }
  for (const run of removedRuns) {
    database.prepare("DELETE FROM sms_runs WHERE id = ?").run(run.id);
  }
  for (const item of removedItems) {
    database.prepare("DELETE FROM sms_items WHERE id = ?").run(item.id);
  }

  const prevItemById = new Map(previous.items.map((item, index) => [item.id, { item, index }]));
  next.items.forEach((item, index) => {
    const old = prevItemById.get(item.id);
    if (old && old.index === index && canonicalJson(projectItem(old.item)) === canonicalJson(projectItem(item))) return;
    database.prepare(
      "INSERT INTO sms_items (id, position, queue, source, external_id, title, content, received_at, accepted_at, status, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, queue = excluded.queue, source = excluded.source, external_id = excluded.external_id, title = excluded.title, content = excluded.content, received_at = excluded.received_at, accepted_at = excluded.accepted_at, status = excluded.status, run_id = excluded.run_id",
    ).run(
      item.id,
      index,
      item.queue,
      item.source,
      item.externalId,
      item.title ?? null,
      item.content,
      item.receivedAt,
      item.acceptedAt,
      item.status,
      item.runId ?? null,
    );
  });

  const prevRunById = new Map(previous.runs.map((run, index) => [run.id, { run, index }]));
  next.runs.forEach((run, index) => {
    const old = prevRunById.get(run.id);
    const hasDecisions = run.decisions === undefined ? 0 : 1;
    const publicationsJson = canonicalJson(run.publications);
    if (!old || old.index !== index || canonicalJson(projectRun(old.run)) !== canonicalJson(projectRun(run))) {
      database.prepare(
        "INSERT INTO sms_runs (id, position, kind, status, created_at, started_at, finished_at, model_status, model_error, has_decisions, publications_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, kind = excluded.kind, status = excluded.status, created_at = excluded.created_at, started_at = excluded.started_at, finished_at = excluded.finished_at, model_status = excluded.model_status, model_error = excluded.model_error, has_decisions = excluded.has_decisions, publications_json = excluded.publications_json",
      ).run(
        run.id,
        index,
        run.kind,
        run.status,
        run.createdAt,
        run.startedAt,
        run.finishedAt ?? null,
        run.model?.status ?? null,
        run.model?.error ?? null,
        hasDecisions,
        publicationsJson,
      );
    }
    if (!old || canonicalJson(old.run.itemIds) !== canonicalJson(run.itemIds)) {
      for (let position = run.itemIds.length; position < (old?.run.itemIds.length ?? 0); position++) {
        database.prepare("DELETE FROM sms_run_items WHERE run_id = ? AND position = ?").run(run.id, position);
      }
      run.itemIds.forEach((itemId, itemIndex) => {
        if (old?.run.itemIds[itemIndex] === itemId) return;
        database.prepare(
          "INSERT INTO sms_run_items (run_id, position, item_id) VALUES (?, ?, ?) ON CONFLICT(run_id, position) DO UPDATE SET item_id = excluded.item_id",
        ).run(run.id, itemIndex, itemId);
      });
    }
    if (!old || canonicalJson(old.run.decisions ?? null) !== canonicalJson(run.decisions ?? null)) {
      const decisions = run.decisions ?? [];
      for (let position = decisions.length; position < (old?.run.decisions?.length ?? 0); position++) {
        database.prepare("DELETE FROM sms_decisions WHERE run_id = ? AND position = ?").run(run.id, position);
      }
      decisions.forEach((decision, decisionIndex) => {
        if (canonicalJson(old?.run.decisions?.[decisionIndex] ?? null) === canonicalJson(decision)) return;
        database.prepare(
          "INSERT INTO sms_decisions (run_id, position, item_id, decision, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, position) DO UPDATE SET item_id = excluded.item_id, decision = excluded.decision, reason = excluded.reason",
        ).run(run.id, decisionIndex, decision.itemId, decision.decision, decision.reason);
      });
    }
  });
};
