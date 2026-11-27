import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { InformationError } from "../../features/information/errors.js";
import type {
  InformationDecision,
  InformationInputItem,
  InformationItem,
  InformationItemStatus,
  InformationPublication,
  InformationPublicationReceipt,
  InformationQueue,
  InformationRun,
  InformationRunKind,
  InformationRunStatus,
  InformationSettings,
  InformationStatusSummary,
} from "../../features/information/types.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import { SQLITE_MODULE_LEDGER_TABLE, type SqliteModule } from "./sqlite-modules.js";

/**
 * 短信/信息领域在 main.sqlite 中的 SQLite 模块定义（Clean Break v4）。
 *
 * - v4 补齐分页/判定投影索引（accepted_at/started_at/decisions），并将仓储完全下沉为精确 SQL 操作，
 *   去除全表 JSON/Zod 重建。
 */
export const SMS_SCHEMA_VERSION = 4;

const DEFAULT_INFORMATION_SETTINGS: InformationSettings = {
  enabled: false,
  batchWindowSeconds: 15,
};

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
  `CREATE INDEX IF NOT EXISTS idx_sms_items_accepted ON sms_items(accepted_at DESC, id DESC)`,
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
  `CREATE INDEX IF NOT EXISTS idx_sms_runs_started ON sms_runs(started_at DESC, id DESC)`,
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
  `CREATE INDEX IF NOT EXISTS idx_sms_decisions_item ON sms_decisions(item_id, run_id)`,
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
  database.prepare(
    "INSERT INTO sms_state (id, schema_version, settings_enabled, settings_batch_window_seconds) VALUES (1, ?, ?, ?)",
  ).run(
    SMS_SCHEMA_VERSION,
    DEFAULT_INFORMATION_SETTINGS.enabled ? 1 : 0,
    DEFAULT_INFORMATION_SETTINGS.batchWindowSeconds,
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

type ItemJoinedRow = {
  id: string;
  position: number;
  queue: InformationQueue;
  source: string;
  external_id: string;
  title: string | null;
  content: string;
  received_at: string;
  accepted_at: string;
  status: InformationItemStatus;
  run_id: string | null;
  decision: "silent" | "notify" | null;
  reason: string | null;
};

type RunRow = {
  id: string;
  position: number;
  kind: InformationRunKind;
  status: InformationRunStatus;
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

export const parsePublicationsJson = (raw: string): InformationPublication[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid main database: corrupted sms run publications");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid main database: corrupted sms run publications");
  }
  return parsed as InformationPublication[];
};

/** ISO 时间戳比较取较晚者；归档波次边界与 finished_at 单调性完全依赖字符串序。 */
const maxIso = (a: string, b: string | null | undefined): string => {
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
};

/** 保证新归档 run 的 started_at 严格晚于上一波简报 run 的 finished_at（0ms 测试环境下也成立）。 */
const nextIsoAfter = (iso: string, floor: string | null | undefined): string => {
  if (!floor) return iso;
  const tIso = Date.parse(iso);
  const tFloor = Date.parse(floor);
  if (Number.isNaN(tIso) || Number.isNaN(tFloor) || tIso > tFloor) return iso;
  return new Date(tFloor + 1).toISOString();
};

const latestArchiveBriefingFinishedAtSync = (database: DatabaseSync): string | null => {
  const row = database.prepare(
    "SELECT MAX(finished_at) AS ts FROM sms_runs WHERE kind = 'archive' AND status = 'completed' AND publications_json != '[]'",
  ).get() as { ts: string | null } | undefined;
  return row?.ts ?? null;
};

const rowToItem = (row: ItemJoinedRow): InformationItem => ({
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
  ...(row.decision !== null && row.reason !== null ? { decision: row.decision, reason: row.reason } : {}),
});

const ITEM_SELECT_SQL = `
  SELECT i.id, i.position, i.queue, i.source, i.external_id, i.title, i.content,
         i.received_at, i.accepted_at, i.status, i.run_id,
         d.decision AS decision, d.reason AS reason
  FROM sms_items i
  LEFT JOIN sms_decisions d ON d.run_id = i.run_id AND d.item_id = i.id
`;

const hydrateRunsSync = (database: DatabaseSync, runRows: readonly RunRow[]): InformationRun[] => {
  if (!runRows.length) return [];
  const placeholders = runRows.map(() => "?").join(", ");
  const ids = runRows.map((r) => r.id);

  const runItemsByRun = new Map<string, string[]>();
  for (const row of database
    .prepare(`SELECT run_id, position, item_id FROM sms_run_items WHERE run_id IN (${placeholders}) ORDER BY run_id, position`)
    .all(...ids) as RunItemRow[]) {
    const list = runItemsByRun.get(row.run_id) ?? [];
    list.push(row.item_id);
    runItemsByRun.set(row.run_id, list);
  }

  const decisionsByRun = new Map<string, InformationDecision[]>();
  for (const row of database
    .prepare(`SELECT run_id, position, item_id, decision, reason FROM sms_decisions WHERE run_id IN (${placeholders}) ORDER BY run_id, position`)
    .all(...ids) as DecisionRow[]) {
    const list = decisionsByRun.get(row.run_id) ?? [];
    list.push({ itemId: row.item_id, decision: row.decision, reason: row.reason });
    decisionsByRun.set(row.run_id, list);
  }

  return runRows.map<InformationRun>((row) => ({
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
    publications: parsePublicationsJson(row.publications_json),
  }));
};

const readRunByIdSync = (database: DatabaseSync, runId: string): InformationRun | undefined => {
  const row = database.prepare(
    "SELECT id, position, kind, status, created_at, started_at, finished_at, model_status, model_error, has_decisions, publications_json FROM sms_runs WHERE id = ?",
  ).get(runId) as RunRow | undefined;
  return row ? hydrateRunsSync(database, [row])[0] : undefined;
};

/** O(1) SQL 检查实时队列是否存在已过批等待窗口的待处理短信。 */
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

export const readSmsSettingsSync = (database: DatabaseSync): InformationSettings => {
  const row = database.prepare(
    "SELECT schema_version, settings_enabled, settings_batch_window_seconds FROM sms_state WHERE id = 1",
  ).get() as StateRow | undefined;
  if (!row) throw new Error("Invalid main database: missing sms_state row");
  return {
    enabled: row.settings_enabled === 1,
    batchWindowSeconds: row.settings_batch_window_seconds,
  };
};

export const writeSmsSettingsSync = (database: DatabaseSync, settings: InformationSettings): InformationSettings => {
  database.prepare(
    "UPDATE sms_state SET schema_version = ?, settings_enabled = ?, settings_batch_window_seconds = ? WHERE id = 1",
  ).run(SMS_SCHEMA_VERSION, settings.enabled ? 1 : 0, settings.batchWindowSeconds);
  return { enabled: settings.enabled, batchWindowSeconds: settings.batchWindowSeconds };
};

export const validateSmsStorageSync = (database: DatabaseSync): void => {
  const state = database.prepare(
    "SELECT schema_version, settings_enabled, settings_batch_window_seconds FROM sms_state WHERE id = 1",
  ).get() as StateRow | undefined;
  if (!state || state.schema_version !== SMS_SCHEMA_VERSION) {
    throw new Error("Invalid main database: corrupted sms_state row");
  }
  const runRows = database.prepare(
    "SELECT id, publications_json FROM sms_runs",
  ).all() as Array<{ id: string; publications_json: string }>;
  for (const row of runRows) {
    parsePublicationsJson(row.publications_json);
  }
  const emptyRun = database.prepare(
    "SELECT r.id FROM sms_runs r WHERE NOT EXISTS (SELECT 1 FROM sms_run_items ri WHERE ri.run_id = r.id) LIMIT 1",
  ).get() as { id: string } | undefined;
  if (emptyRun) {
    throw new Error(`Invalid main database: sms run ${emptyRun.id} has no items`);
  }
  const badDecision = database.prepare(
    "SELECT d.run_id, d.item_id FROM sms_decisions d WHERE NOT EXISTS (SELECT 1 FROM sms_run_items ri WHERE ri.run_id = d.run_id AND ri.item_id = d.item_id) LIMIT 1",
  ).get() as { run_id: string; item_id: string } | undefined;
  if (badDecision) {
    throw new Error(`Invalid main database: decision references item ${badDecision.item_id} outside run ${badDecision.run_id}`);
  }
};

export const ingestSmsItemsSync = (
  database: DatabaseSync,
  queue: InformationQueue,
  inputs: readonly InformationInputItem[],
  now: string,
): { accepted: InformationItem[]; responseItems: InformationItem[]; skippedCount: number; autoEnabled: boolean } => {
  const settings = readSmsSettingsSync(database);
  let autoEnabled = false;
  if (inputs.length > 0 && !settings.enabled) {
    writeSmsSettingsSync(database, { ...settings, enabled: true });
    autoEnabled = true;
  }

  let nextPosition =
    ((database.prepare("SELECT COALESCE(MAX(position), -1) AS max_pos FROM sms_items").get() as { max_pos: number }).max_pos) + 1;

  const findExistingStmt = database.prepare(
    `${ITEM_SELECT_SQL} WHERE i.source = ? AND i.external_id = ? LIMIT 1`,
  );
  const insertItemStmt = database.prepare(
    "INSERT INTO sms_items (id, position, queue, source, external_id, title, content, received_at, accepted_at, status, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)",
  );

  const pendingByBatchKey = new Map<string, InformationItem>();
  const accepted: InformationItem[] = [];
  const responseItems: InformationItem[] = [];
  const seenResponseIds = new Set<string>();
  let skippedCount = 0;

  for (const input of inputs) {
    const key = `${input.source}\0${input.externalId}`;
    let existing = pendingByBatchKey.get(key);
    if (!existing) {
      const row = findExistingStmt.get(input.source, input.externalId) as ItemJoinedRow | undefined;
      if (row) existing = rowToItem(row);
    }

    if (existing) {
      const timeMismatch =
        input.receivedAt !== undefined &&
        Date.parse(existing.receivedAt) !== Date.parse(input.receivedAt);
      if (
        existing.content !== input.content ||
        (existing.title ?? undefined) !== (input.title ?? undefined) ||
        timeMismatch
      ) {
        throw new InformationError(
          "CONFLICT",
          `Conflicting content for existing source=${input.source} externalId=${input.externalId}`,
        );
      }
      skippedCount++;
      if (!seenResponseIds.has(existing.id)) {
        seenResponseIds.add(existing.id);
        responseItems.push(existing);
      }
      continue;
    }

    const created: InformationItem = {
      id: `info_${randomUUID()}`,
      queue,
      source: input.source,
      externalId: input.externalId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      content: input.content,
      receivedAt: input.receivedAt ?? now,
      acceptedAt: now,
      status: "pending",
    };
    insertItemStmt.run(
      created.id,
      nextPosition++,
      created.queue,
      created.source,
      created.externalId,
      created.title ?? null,
      created.content,
      created.receivedAt,
      created.acceptedAt,
    );
    pendingByBatchKey.set(key, created);
    seenResponseIds.add(created.id);
    accepted.push(created);
    responseItems.push(created);
  }

  return { accepted, responseItems, skippedCount, autoEnabled };
};

export const listSmsItemsSync = (
  database: DatabaseSync,
  options: {
    queue?: InformationQueue;
    status?: InformationItemStatus;
    limit: number;
    after?: { at: string; id: string };
  },
): { items: InformationItem[]; hasMore: boolean } => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.queue !== undefined) {
    clauses.push("i.queue = ?");
    params.push(options.queue);
  }
  if (options.status !== undefined) {
    clauses.push("i.status = ?");
    params.push(options.status);
  }
  if (options.after !== undefined) {
    clauses.push("(i.accepted_at < ? OR (i.accepted_at = ? AND i.id < ?))");
    params.push(options.after.at, options.after.at, options.after.id);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `${ITEM_SELECT_SQL} ${where} ORDER BY i.accepted_at DESC, i.id DESC LIMIT ?`;
  params.push(options.limit + 1);
  const rows = database.prepare(sql).all(...params) as ItemJoinedRow[];
  const hasMore = rows.length > options.limit;
  return {
    items: (hasMore ? rows.slice(0, options.limit) : rows).map(rowToItem),
    hasMore,
  };
};

export const getSmsItemSync = (
  database: DatabaseSync,
  itemId: string,
): { item: InformationItem; runs: InformationRun[] } | undefined => {
  const row = database.prepare(`${ITEM_SELECT_SQL} WHERE i.id = ? LIMIT 1`).get(itemId) as ItemJoinedRow | undefined;
  if (!row) return undefined;
  const runRows = database.prepare(
    `SELECT r.id, r.position, r.kind, r.status, r.created_at, r.started_at, r.finished_at, r.model_status, r.model_error, r.has_decisions, r.publications_json
     FROM sms_runs r
     INNER JOIN sms_run_items ri ON ri.run_id = r.id
     WHERE ri.item_id = ?
     ORDER BY r.created_at DESC, r.id DESC`,
  ).all(itemId) as RunRow[];
  return {
    item: rowToItem(row),
    runs: hydrateRunsSync(database, runRows),
  };
};

export const listSmsRunsSync = (
  database: DatabaseSync,
  options: {
    kind?: InformationRunKind;
    status?: InformationRunStatus;
    limit: number;
    after?: { at: string; id: string };
  },
): { runs: InformationRun[]; hasMore: boolean } => {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(options.kind);
  }
  if (options.status !== undefined) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.after !== undefined) {
    clauses.push("(started_at < ? OR (started_at = ? AND id < ?))");
    params.push(options.after.at, options.after.at, options.after.id);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT id, position, kind, status, created_at, started_at, finished_at, model_status, model_error, has_decisions, publications_json FROM sms_runs ${where} ORDER BY started_at DESC, id DESC LIMIT ?`;
  params.push(options.limit + 1);
  const runRows = database.prepare(sql).all(...params) as RunRow[];
  const hasMore = runRows.length > options.limit;
  const page = hasMore ? runRows.slice(0, options.limit) : runRows;
  return {
    runs: hydrateRunsSync(database, page),
    hasMore,
  };
};

export const getSmsRunSync = (
  database: DatabaseSync,
  runId: string,
): { run: InformationRun; items: InformationItem[] } | undefined => {
  const run = readRunByIdSync(database, runId);
  if (!run) return undefined;
  const rows = database.prepare(
    `${ITEM_SELECT_SQL}
     INNER JOIN sms_run_items ri ON ri.item_id = i.id
     WHERE ri.run_id = ?
     ORDER BY ri.position`,
  ).all(runId) as ItemJoinedRow[];
  return { run, items: rows.map(rowToItem) };
};

export const getSmsStatusSummarySync = (database: DatabaseSync): InformationStatusSummary => {
  const settings = readSmsSettingsSync(database);
  let pendingCount = 0;
  let failedCount = 0;
  let archivePendingCount = 0;
  let archiveProcessedCount = 0;
  let archiveFailedCount = 0;

  for (const row of database
    .prepare("SELECT queue, status, COUNT(*) AS cnt FROM sms_items GROUP BY queue, status")
    .all() as Array<{ queue: InformationQueue; status: InformationItemStatus; cnt: number }>) {
    if (row.queue === "realtime") {
      if (row.status === "pending") pendingCount = row.cnt;
      else if (row.status === "failed") failedCount = row.cnt;
    } else if (row.status === "pending") {
      archivePendingCount = row.cnt;
    } else if (row.status === "processed") {
      archiveProcessedCount = row.cnt;
    } else if (row.status === "failed") {
      archiveFailedCount = row.cnt;
    }
  }

  const hasRunningRow = Boolean(
    database.prepare("SELECT 1 FROM sms_runs WHERE status = 'running' LIMIT 1").get(),
  );
  const latestRun = database.prepare(
    "SELECT status, started_at, finished_at, model_error, publications_json FROM sms_runs ORDER BY started_at DESC, id DESC LIMIT 1",
  ).get() as {
    status: InformationRunStatus;
    started_at: string;
    finished_at: string | null;
    model_error: string | null;
    publications_json: string;
  } | undefined;

  let lastError: string | null = null;
  if (latestRun?.status === "failed") {
    lastError = latestRun.model_error ?? "MODEL_REQUEST_FAILED";
  } else if (latestRun) {
    const failedPub = parsePublicationsJson(latestRun.publications_json)
      .find((pub) => pub.status === "failed" && pub.error);
    if (failedPub?.error) lastError = failedPub.error;
  }

  return {
    enabled: settings.enabled,
    batchWindowSeconds: settings.batchWindowSeconds,
    hasRunningRow,
    pendingCount,
    failedCount,
    archivePendingCount,
    archiveProcessedCount,
    archiveFailedCount,
    lastRunAt: latestRun ? (latestRun.finished_at ?? latestRun.started_at) : null,
    lastError,
  };
};

export const requeueFailedSmsSync = (database: DatabaseSync, queue: InformationQueue): number => {
  const result = database
    .prepare("UPDATE sms_items SET status = 'pending', run_id = NULL WHERE queue = ? AND status = 'failed'")
    .run(queue);
  return Number(result.changes ?? 0);
};

/** 创建 running run 并原子认领选中条目；归档 run 的 started_at 需晚于上一波简报 run 的 finished_at。 */
const createClaimedRunSync = (
  database: DatabaseSync,
  queue: InformationQueue,
  selected: InformationItem[],
  now: string,
): { run: InformationRun; items: InformationItem[] } => {
  const effectiveNow = queue === "archive" ? nextIsoAfter(now, latestArchiveBriefingFinishedAtSync(database)) : now;
  const runId = `inforun_${randomUUID()}`;
  const runPosition =
    ((database.prepare("SELECT COALESCE(MAX(position), -1) AS max_pos FROM sms_runs").get() as { max_pos: number }).max_pos) + 1;
  database.prepare(
    "INSERT INTO sms_runs (id, position, kind, status, created_at, started_at, finished_at, model_status, model_error, has_decisions, publications_json) VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, 0, '[]')",
  ).run(runId, runPosition, queue, effectiveNow, effectiveNow);

  const updateItemStmt = database.prepare("UPDATE sms_items SET status = 'processing', run_id = ? WHERE id = ?");
  const insertRunItemStmt = database.prepare("INSERT INTO sms_run_items (run_id, position, item_id) VALUES (?, ?, ?)");
  selected.forEach((item, index) => {
    item.runId = runId;
    updateItemStmt.run(runId, item.id);
    insertRunItemStmt.run(runId, index, item.id);
  });

  const run: InformationRun = {
    id: runId,
    kind: queue,
    status: "running",
    createdAt: effectiveNow,
    startedAt: effectiveNow,
    itemIds: selected.map((item) => item.id),
    publications: [],
  };
  return { run, items: selected };
};

export const claimSmsBatchSync = (
  database: DatabaseSync,
  queue: InformationQueue,
  options: { forceRealtime: boolean; maxItems: number; maxChars: number; now: string },
): { run: InformationRun; items: InformationItem[] } | null => {
  const settings = readSmsSettingsSync(database);
  if (queue === "realtime" && !options.forceRealtime && !settings.enabled) {
    return null;
  }
  const pendingRows = database.prepare(
    `${ITEM_SELECT_SQL} WHERE i.queue = ? AND i.status = 'pending' ORDER BY i.position LIMIT ?`,
  ).all(queue, options.maxItems) as ItemJoinedRow[];
  if (!pendingRows.length) return null;

  if (queue === "realtime" && !options.forceRealtime) {
    const dueAt = Date.parse(pendingRows[0]!.accepted_at) + settings.batchWindowSeconds * 1000;
    if (!Number.isNaN(dueAt) && Date.now() < dueAt) return null;
  }

  const selected: InformationItem[] = [];
  let chars = 0;
  for (const row of pendingRows) {
    if (selected.length >= options.maxItems) break;
    if (selected.length > 0 && chars + row.content.length > options.maxChars) break;
    selected.push({ ...rowToItem(row), status: "processing" });
    chars += row.content.length;
  }

  return createClaimedRunSync(database, queue, selected, options.now);
};

/** 二分隔离专用：按精确条目 ID 认领仍 pending 的子切片（保持原 position 顺序）。 */
export const claimSmsItemsSync = (
  database: DatabaseSync,
  queue: InformationQueue,
  itemIds: readonly string[],
  now: string,
): { run: InformationRun; items: InformationItem[] } | null => {
  if (!itemIds.length) return null;
  const placeholders = itemIds.map(() => "?").join(", ");
  const rows = database.prepare(
    `${ITEM_SELECT_SQL} WHERE i.queue = ? AND i.status = 'pending' AND i.id IN (${placeholders}) ORDER BY i.position`,
  ).all(queue, ...itemIds) as ItemJoinedRow[];
  if (!rows.length) return null;
  return createClaimedRunSync(
    database,
    queue,
    rows.map((row) => ({ ...rowToItem(row), status: "processing" })),
    now,
  );
};

export const revertClaimedSmsRunSync = (
  database: DatabaseSync,
  runId: string,
  itemIds: readonly string[],
  finishedAt: string,
): InformationRun => {
  database.prepare("UPDATE sms_runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(finishedAt, runId);
  const stmt = database.prepare("UPDATE sms_items SET status = 'pending', run_id = NULL WHERE id = ? AND status = 'processing'");
  for (const itemId of itemIds) stmt.run(itemId);
  const run = readRunByIdSync(database, runId);
  if (!run) throw new InformationError("NOT_FOUND", `Unknown information run: ${runId}`);
  return run;
};

export const markSmsRunFailedSync = (
  database: DatabaseSync,
  runId: string,
  itemIds: readonly string[],
  errorMessage: string,
  finishedAt: string,
): InformationRun => {
  const existing = database.prepare("SELECT started_at FROM sms_runs WHERE id = ?").get(runId) as
    | { started_at: string }
    | undefined;
  const effectiveFinished = maxIso(finishedAt, existing?.started_at);
  database.prepare(
    "UPDATE sms_runs SET status = 'failed', finished_at = ?, model_status = 'failed', model_error = ? WHERE id = ?",
  ).run(effectiveFinished, errorMessage, runId);
  const stmt = database.prepare("UPDATE sms_items SET status = 'failed' WHERE id = ?");
  for (const itemId of itemIds) stmt.run(itemId);
  const run = readRunByIdSync(database, runId);
  if (!run) throw new InformationError("NOT_FOUND", `Unknown information run: ${runId}`);
  return run;
};

/**
 * 二分隔离：多条目批次被上游内容审核拒绝时，把该 run 标记为失败（model_error 保留
 * MODEL_CONTENT_REJECTED 以便后续只按确定性拒绝放行简报），但把条目回退为 pending，
 * 供二分循环继续按子切片认领，只有最终单条切片仍会真正失败。
 */
export const markSmsRunSplitSync = (
  database: DatabaseSync,
  runId: string,
  itemIds: readonly string[],
  errorMessage: string,
  finishedAt: string,
): InformationRun => {
  const existing = database.prepare("SELECT started_at FROM sms_runs WHERE id = ?").get(runId) as
    | { started_at: string }
    | undefined;
  const effectiveFinished = maxIso(finishedAt, existing?.started_at);
  database.prepare(
    "UPDATE sms_runs SET status = 'failed', finished_at = ?, model_status = 'failed', model_error = ? WHERE id = ?",
  ).run(effectiveFinished, errorMessage, runId);
  const revertStmt = database.prepare(
    "UPDATE sms_items SET status = 'pending', run_id = NULL WHERE id = ? AND status = 'processing'",
  );
  for (const itemId of itemIds) revertStmt.run(itemId);
  const run = readRunByIdSync(database, runId);
  if (!run) throw new InformationError("NOT_FOUND", `Unknown information run: ${runId}`);
  return run;
};

export const completeSmsModelRoundSync = (
  database: DatabaseSync,
  input: {
    runId: string;
    itemIds: readonly string[];
    decisions: readonly InformationDecision[];
    publications: readonly InformationPublication[];
    finishedAt: string;
  },
): InformationRun => {
  const hasPending = input.publications.length > 0;
  database.prepare(
    "UPDATE sms_runs SET status = ?, finished_at = ?, model_status = 'succeeded', model_error = NULL, has_decisions = 1, publications_json = ? WHERE id = ?",
  ).run(
    hasPending ? "running" : "completed",
    hasPending ? null : input.finishedAt,
    canonicalJson(input.publications),
    input.runId,
  );
  database.prepare("DELETE FROM sms_decisions WHERE run_id = ?").run(input.runId);
  const insertDecisionStmt = database.prepare(
    "INSERT INTO sms_decisions (run_id, position, item_id, decision, reason) VALUES (?, ?, ?, ?, ?)",
  );
  input.decisions.forEach((decision, index) => {
    insertDecisionStmt.run(input.runId, index, decision.itemId, decision.decision, decision.reason);
  });
  const markItemStmt = database.prepare("UPDATE sms_items SET status = 'processed' WHERE id = ?");
  for (const itemId of input.itemIds) markItemStmt.run(itemId);
  const run = readRunByIdSync(database, input.runId);
  if (!run) throw new InformationError("NOT_FOUND", `Unknown information run: ${input.runId}`);
  return run;
};

export const updateSmsPublicationSync = (
  database: DatabaseSync,
  runId: string,
  notificationId: string,
  update: { status: "published" | "failed"; receipt?: InformationPublicationReceipt; error?: string },
): void => {
  const row = database.prepare("SELECT publications_json FROM sms_runs WHERE id = ?").get(runId) as { publications_json: string } | undefined;
  if (!row) return;
  const publications = parsePublicationsJson(row.publications_json).map((pub) => {
    if (pub.notificationId !== notificationId) return pub;
    if (update.status === "published" && update.receipt) {
      return { notificationId: pub.notificationId, text: pub.text, itemIds: pub.itemIds, status: "published" as const, receipt: update.receipt };
    }
    return {
      notificationId: pub.notificationId,
      text: pub.text,
      itemIds: pub.itemIds,
      status: "failed" as const,
      error: update.error ?? "Notification failed",
    };
  });
  database.prepare("UPDATE sms_runs SET publications_json = ? WHERE id = ?").run(canonicalJson(publications), runId);
};

export const failPendingSmsPublicationsSync = (database: DatabaseSync, runId: string, reason: string): void => {
  const row = database.prepare("SELECT publications_json FROM sms_runs WHERE id = ?").get(runId) as { publications_json: string } | undefined;
  if (!row) return;
  const publications = parsePublicationsJson(row.publications_json).map((pub) =>
    pub.status === "pending" ? { ...pub, status: "failed" as const, error: reason } : pub);
  database.prepare("UPDATE sms_runs SET publications_json = ? WHERE id = ?").run(canonicalJson(publications), runId);
};

export const finalizeSmsDeliverySync = (
  database: DatabaseSync,
  runId: string,
  finishedAt: string,
  interruptReason: string,
): InformationRun => {
  const row = database.prepare(
    "SELECT kind, publications_json FROM sms_runs WHERE id = ?",
  ).get(runId) as { kind: InformationRunKind; publications_json: string } | undefined;
  if (!row) throw new InformationError("NOT_FOUND", `Unknown information run: ${runId}`);
  const publications = parsePublicationsJson(row.publications_json).map((pub) =>
    pub.status === "pending" ? { ...pub, status: "failed" as const, error: interruptReason } : pub);
  let effectiveFinished = finishedAt;
  if (row.kind === "archive" && publications.length > 0) {
    // 归档简报 run 的 finished_at 必须晚于同波次所有 run，保证波次回溯边界正确。
    const maxRow = database.prepare(
      "SELECT MAX(finished_at) AS ts FROM sms_runs WHERE kind = 'archive' AND finished_at IS NOT NULL",
    ).get() as { ts: string | null } | undefined;
    effectiveFinished = maxIso(finishedAt, maxRow?.ts);
  }
  database.prepare(
    "UPDATE sms_runs SET status = 'completed', finished_at = ?, publications_json = ? WHERE id = ?",
  ).run(effectiveFinished, canonicalJson(publications), runId);
  const run = readRunByIdSync(database, runId);
  if (!run) throw new InformationError("NOT_FOUND", `Unknown information run: ${runId}`);
  return run;
};

export const setSmsRunPublicationsSync = (
  database: DatabaseSync,
  runId: string,
  publications: readonly InformationPublication[],
): void => {
  database.prepare("UPDATE sms_runs SET publications_json = ? WHERE id = ?").run(canonicalJson(publications), runId);
};

export const getSmsNotificationContextSync = (
  database: DatabaseSync,
  notificationId: string,
): { runId: string; publication: InformationPublication; items: InformationItem[] } | undefined => {
  const candidates = database.prepare(
    "SELECT id, publications_json FROM sms_runs WHERE publications_json LIKE '%' || ? || '%' ORDER BY position DESC",
  ).all(notificationId) as Array<{ id: string; publications_json: string }>;
  for (const row of candidates) {
    const pub = parsePublicationsJson(row.publications_json).find((entry) => entry.notificationId === notificationId);
    if (!pub) continue;
    if (!pub.itemIds.length) return { runId: row.id, publication: pub, items: [] };
    const placeholders = pub.itemIds.map(() => "?").join(", ");
    const itemRows = database.prepare(`${ITEM_SELECT_SQL} WHERE i.id IN (${placeholders})`).all(...pub.itemIds) as ItemJoinedRow[];
    const itemById = new Map(itemRows.map((itemRow) => [itemRow.id, rowToItem(itemRow)]));
    const items = pub.itemIds.map((id) => itemById.get(id)).filter((item): item is InformationItem => Boolean(item));
    return { runId: row.id, publication: pub, items };
  }
  return undefined;
};

export const getSmsArchiveBriefingWaveSync = (
  database: DatabaseSync,
): { itemsById: Map<string, InformationItem>; waveRuns: InformationRun[]; skippedCount: number } | null => {
  if (!database.prepare("SELECT 1 FROM sms_items WHERE queue = 'archive' LIMIT 1").get()) return null;
  if (database.prepare("SELECT 1 FROM sms_items WHERE queue = 'archive' AND status IN ('pending', 'processing') LIMIT 1").get()) {
    return null;
  }
  // 仍存在的归档失败条目：只有全部来自上游内容安全审核的确定性拒绝（单条毒丸）才允许发简报；
  // 任何瞬时/全局故障（网络、5xx、无效结果）都必须继续阻断，等待 retryFailed 重跑。
  const failedRows = database.prepare(
    `SELECT i.id, r.model_error AS model_error, r.started_at AS started_at
     FROM sms_items i
     LEFT JOIN sms_runs r ON r.id = i.run_id
     WHERE i.queue = 'archive' AND i.status = 'failed'`,
  ).all() as Array<{ id: string; model_error: string | null; started_at: string | null }>;
  if (failedRows.some((row) => row.model_error !== "MODEL_CONTENT_REJECTED")) return null;

  const runRows = database.prepare(
    "SELECT id, position, kind, status, created_at, started_at, finished_at, model_status, model_error, has_decisions, publications_json FROM sms_runs WHERE kind = 'archive' AND status = 'completed' ORDER BY position ASC",
  ).all() as RunRow[];
  const runs = hydrateRunsSync(database, runRows);
  const waveRuns: InformationRun[] = [];
  let lastBriefingRun: InformationRun | undefined;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    if (run.publications.length > 0) {
      lastBriefingRun = run;
      break;
    }
    waveRuns.unshift(run);
  }
  if (!waveRuns.length) return null;

  // 波次内被审核拒绝的条目数：仅统计上一波简报 run 完成之后产生的失败（按 started_at 分界）。
  const skippedCount = failedRows.filter((row) => {
    if (!lastBriefingRun) return true;
    if (row.started_at === null || lastBriefingRun.finishedAt === undefined) return false;
    return row.started_at > lastBriefingRun.finishedAt;
  }).length;

  const neededItemIds = new Set<string>();
  for (const run of waveRuns) {
    for (const decision of run.decisions ?? []) {
      if (decision.decision === "notify") neededItemIds.add(decision.itemId);
    }
  }
  const itemsById = new Map<string, InformationItem>();
  if (neededItemIds.size > 0) {
    const ids = [...neededItemIds];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = database.prepare(`${ITEM_SELECT_SQL} WHERE i.id IN (${placeholders}) AND i.queue = 'archive'`).all(...ids) as ItemJoinedRow[];
    for (const row of rows) itemsById.set(row.id, rowToItem(row));
  }
  return { itemsById, waveRuns, skippedCount };
};

export const pruneSmsHistorySync = (
  database: DatabaseSync,
  limits: { maxProcessedRealtimeItems?: number; maxProcessedArchiveItems?: number } = {},
): { deletedItems: number; deletedRuns: number } => {
  const maxRealtime = Math.max(0, limits.maxProcessedRealtimeItems ?? 1000);
  const maxArchive = Math.max(0, limits.maxProcessedArchiveItems ?? 2000);
  const staleIds = [
    ...(database.prepare(
      "SELECT id FROM sms_items WHERE queue = 'realtime' AND status = 'processed' ORDER BY accepted_at DESC, id DESC LIMIT -1 OFFSET ?",
    ).all(maxRealtime) as Array<{ id: string }>),
    ...(database.prepare(
      "SELECT id FROM sms_items WHERE queue = 'archive' AND status = 'processed' ORDER BY accepted_at DESC, id DESC LIMIT -1 OFFSET ?",
    ).all(maxArchive) as Array<{ id: string }>),
  ].map((row) => row.id);

  if (!staleIds.length) return { deletedItems: 0, deletedRuns: 0 };

  const delDecisionsByItem = database.prepare("DELETE FROM sms_decisions WHERE item_id = ?");
  const delRunItemsByItem = database.prepare("DELETE FROM sms_run_items WHERE item_id = ?");
  const delItem = database.prepare("DELETE FROM sms_items WHERE id = ?");
  for (const id of staleIds) {
    delDecisionsByItem.run(id);
    delRunItemsByItem.run(id);
    delItem.run(id);
  }

  const emptyRunIds = (database.prepare(
    "SELECT r.id FROM sms_runs r WHERE r.status != 'running' AND NOT EXISTS (SELECT 1 FROM sms_run_items ri WHERE ri.run_id = r.id)",
  ).all() as Array<{ id: string }>).map((row) => row.id);

  const delDecisionsByRun = database.prepare("DELETE FROM sms_decisions WHERE run_id = ?");
  const delRun = database.prepare("DELETE FROM sms_runs WHERE id = ?");
  for (const runId of emptyRunIds) {
    delDecisionsByRun.run(runId);
    delRun.run(runId);
  }

  return { deletedItems: staleIds.length, deletedRuns: emptyRunIds.length };
};

export const reconcileSmsOnStartSync = (database: DatabaseSync, now: string): void => {
  const interruptedCompleted = database.prepare(
    "SELECT id, publications_json FROM sms_runs WHERE status = 'completed' AND publications_json LIKE '%\"pending\"%'",
  ).all() as Array<{ id: string; publications_json: string }>;
  for (const row of interruptedCompleted) {
    const pubs = parsePublicationsJson(row.publications_json);
    if (!pubs.some((p) => p.status === "pending")) continue;
    const updated = pubs.map((p) =>
      p.status === "pending" ? { ...p, status: "failed" as const, error: "Interrupted by service restart" } : p);
    database.prepare("UPDATE sms_runs SET publications_json = ? WHERE id = ?").run(canonicalJson(updated), row.id);
  }

  const runningRows = database.prepare(
    "SELECT id, model_status, publications_json FROM sms_runs WHERE status = 'running'",
  ).all() as Array<{ id: string; model_status: "succeeded" | "failed" | null; publications_json: string }>;
  for (const row of runningRows) {
    if (row.model_status === "succeeded") {
      const updated = parsePublicationsJson(row.publications_json).map((p) =>
        p.status === "pending" ? { ...p, status: "failed" as const, error: "Interrupted by service restart" } : p);
      database.prepare(
        "UPDATE sms_runs SET status = 'completed', finished_at = ?, publications_json = ? WHERE id = ?",
      ).run(now, canonicalJson(updated), row.id);
    } else {
      database.prepare(
        "UPDATE sms_runs SET status = 'failed', finished_at = ?, model_status = 'failed', model_error = 'Interrupted by service restart' WHERE id = ?",
      ).run(now, row.id);
    }
  }

  database.prepare("UPDATE sms_items SET status = 'pending', run_id = NULL WHERE status = 'processing'").run();
};
