import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import { SQLITE_MODULE_LEDGER_TABLE, type SqliteModule } from "./sqlite-modules.js";
import {
  defaultInformationState,
  type InformationArticleFeedback,
  type InformationDecision,
  type InformationItem,
  type InformationRun,
  type InformationState,
} from "../../features/information/types.js";

/**
 * 短信模块在 main.sqlite 的表结构与行映射。
 *
 * owner 边界：短信与新闻是两个业务 owner，共用同一 main.sqlite 连接但互不共享表。
 * 本模块只建立 sms_* 表，绝不创建或读取 news_* 表；新闻库也不出现 sms_* 表。
 *
 * 设计要点：
 * - 核心字段入列；run.publications 这种罕见历史形状保留为规范 JSON 列保真。
 * - 数组顺序（条目、run、run 成员、决定、反馈、评论）用 position 列保真，
 *   同一 acceptedAt 的条目按接纳顺序读回，不靠时间戳排序。
 * - 读取只声明显式列，写入只 UPDATE/INSERT 显式列：Agent 加列/加表不会被行级
 *   diff 抹掉，未变化的行不会被整表重写。
 * - 删除顺序先子后父（评论→反馈→run 明细/决定→run→条目），写入顺序先父后子，
 *   满足外键约束；run_items/decisions/feedback 引用条目，条目先落库。
 */
const SMS_SCHEMA_VERSION = 1;

const SMS_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS sms_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    settings_enabled INTEGER NOT NULL CHECK (settings_enabled IN (0, 1)),
    settings_batch_window_seconds INTEGER NOT NULL,
    settings_mode TEXT NOT NULL CHECK (settings_mode IN ('notifications', 'recommendations')),
    preferences_learned_notes TEXT NOT NULL,
    initial_analysis_completed INTEGER CHECK (initial_analysis_completed IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS sms_items (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    received_at TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    run_id TEXT,
    metadata_present INTEGER NOT NULL CHECK (metadata_present IN (0, 1)),
    metadata_source_id TEXT,
    metadata_source_title TEXT,
    metadata_url TEXT,
    UNIQUE (source, external_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sms_runs (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    created_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    kind TEXT CHECK (kind IN ('initial_summary', 'incremental')),
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
  `CREATE TABLE IF NOT EXISTS sms_feedback (
    item_id TEXT PRIMARY KEY REFERENCES sms_items(id),
    position INTEGER NOT NULL,
    reaction TEXT CHECK (reaction IN ('like', 'dislike')),
    saved INTEGER NOT NULL CHECK (saved IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS sms_feedback_comments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES sms_feedback(item_id),
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
] as const;

const SMS_TABLES = [
  "sms_state",
  "sms_items",
  "sms_runs",
  "sms_run_items",
  "sms_decisions",
  "sms_feedback",
  "sms_feedback_comments",
] as const;

/**
 * 短信模块登记信息。模块 id 与表名前缀一致，主会话的模块注册表按此登记到
 * main.sqlite 的迁移账本；本文件不自己开库，也不自己登记账本。
 */
export const smsModule: SqliteModule = {
  id: "sms",
  version: SMS_SCHEMA_VERSION,
  tables: SMS_TABLES,
  ddl: SMS_TABLE_DDL,
};

/** 稳定 key 序列化：同一逻辑 payload 不因对象 key 顺序产生不同存储字节。 */
export const canonicalJson = (value: unknown): string => {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
};

const tableExists = (managed: ManagedSqliteDatabase, table: string): boolean =>
  Boolean(managed.database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));

const insertDefaultSmsState = (managed: ManagedSqliteDatabase): void => {
  const state = defaultInformationState();
  managed.database.prepare(
    "INSERT INTO sms_state (id, schema_version, settings_enabled, settings_batch_window_seconds, settings_mode, preferences_learned_notes, initial_analysis_completed) VALUES (1, ?, ?, ?, ?, ?, ?)",
  ).run(
    state.schemaVersion,
    state.settings.enabled ? 1 : 0,
    state.settings.batchWindowSeconds,
    state.settings.mode,
    state.preferences.learnedNotes,
    state.initialAnalysisCompleted === undefined ? null : state.initialAnalysisCompleted ? 1 : 0,
  );
};

/**
 * 结构校验与默认状态初始化：
 * - 模块必须已在迁移账本登记且版本一致，缺表视为结构损坏并失败；
 * - 状态单例缺失时，只有在其他 sms 表也没有数据的情况下才写默认值；
 *   已用过的模块丢了状态行说明结构被破坏，必须显式失败，不静默置空。
 */
export const ensureSmsModule = (managed: ManagedSqliteDatabase): void => {
  if (!tableExists(managed, SQLITE_MODULE_LEDGER_TABLE)) {
    throw new Error("Invalid main database: missing schema ledger; ensureSqliteModules must run before the SMS repository is created");
  }
  const registered = managed.database
    .prepare(`SELECT version FROM ${SQLITE_MODULE_LEDGER_TABLE} WHERE module = ?`)
    .get("sms") as { version: number } | undefined;
  if (!registered) throw new Error("Invalid main database: module sms is not registered");
  if (registered.version !== SMS_SCHEMA_VERSION) {
    throw new Error(`Invalid main database: module sms has version ${registered.version}, expected ${SMS_SCHEMA_VERSION}`);
  }
  for (const table of SMS_TABLES) {
    if (!tableExists(managed, table)) {
      throw new Error(`Invalid main database: module sms is missing table ${table}`);
    }
  }
  if (managed.database.prepare("SELECT 1 FROM sms_state WHERE id = 1").get()) return;
  for (const table of ["sms_items", "sms_runs", "sms_run_items", "sms_decisions", "sms_feedback", "sms_feedback_comments"]) {
    if (managed.database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
      throw new Error("Invalid main database: missing sms_state row");
    }
  }
  insertDefaultSmsState(managed);
};

type StateRow = {
  schema_version: 1;
  settings_enabled: number;
  settings_batch_window_seconds: number;
  settings_mode: "notifications" | "recommendations";
  preferences_learned_notes: string;
  initial_analysis_completed: number | null;
};
type ItemRow = {
  id: string; position: number; source: string; external_id: string; title: string | null; content: string;
  received_at: string; accepted_at: string; status: InformationItem["status"]; run_id: string | null;
  metadata_present: number; metadata_source_id: string | null; metadata_source_title: string | null; metadata_url: string | null;
};
type RunRow = {
  id: string; position: number; status: InformationRun["status"]; created_at: string; started_at: string;
  finished_at: string | null; kind: InformationRun["kind"] | null; model_status: "succeeded" | "failed" | null;
  model_error: string | null; has_decisions: number; publications_json: string;
};
type RunItemRow = { run_id: string; position: number; item_id: string };
type DecisionRow = { run_id: string; position: number; item_id: string; decision: "silent" | "notify"; reason: string };
type FeedbackRow = { item_id: string; position: number; reaction: "like" | "dislike" | null; saved: number };
type CommentRow = { id: string; item_id: string; position: number; text: string; created_at: string; updated_at: string };

const parsePublications = (raw: string): InformationRun["publications"] => {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) throw new Error("not an array");
    return value as InformationRun["publications"];
  } catch {
    throw new Error("Invalid main database: corrupted sms run publications");
  }
};

/** 从显式列装配完整 InformationState 聚合；结构合法性由仓储层的严格校验负责。 */
export const readSmsState = (managed: ManagedSqliteDatabase): InformationState => {
  const database = managed.database;
  const stateRow = database.prepare(
    "SELECT schema_version, settings_enabled, settings_batch_window_seconds, settings_mode, preferences_learned_notes, initial_analysis_completed FROM sms_state WHERE id = 1",
  ).get() as StateRow | undefined;
  if (!stateRow) throw new Error("Invalid main database: missing sms_state row");

  const items = (database.prepare(
    "SELECT id, position, source, external_id, title, content, received_at, accepted_at, status, run_id, metadata_present, metadata_source_id, metadata_source_title, metadata_url FROM sms_items ORDER BY position",
  ).all() as ItemRow[]).map<InformationItem>((row) => ({
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    ...(row.title !== null ? { title: row.title } : {}),
    content: row.content,
    receivedAt: row.received_at,
    acceptedAt: row.accepted_at,
    status: row.status,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.metadata_present === 1
      ? {
        metadata: {
          sourceId: row.metadata_source_id!,
          sourceTitle: row.metadata_source_title!,
          url: row.metadata_url,
        },
      }
      : {}),
  }));

  const commentsByItem = new Map<string, InformationArticleFeedback["comments"]>();
  for (const row of database.prepare(
    "SELECT id, item_id, position, text, created_at, updated_at FROM sms_feedback_comments ORDER BY position",
  ).all() as CommentRow[]) {
    const list = commentsByItem.get(row.item_id) ?? [];
    list.push({ id: row.id, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at });
    commentsByItem.set(row.item_id, list);
  }
  const articleFeedback = (database.prepare(
    "SELECT item_id, position, reaction, saved FROM sms_feedback ORDER BY position",
  ).all() as FeedbackRow[]).map<InformationArticleFeedback>((row) => ({
    itemId: row.item_id,
    reaction: row.reaction,
    saved: row.saved === 1,
    comments: commentsByItem.get(row.item_id) ?? [],
  }));

  const runItemsByRun = new Map<string, string[]>();
  for (const row of database.prepare(
    "SELECT run_id, position, item_id FROM sms_run_items ORDER BY position",
  ).all() as RunItemRow[]) {
    const list = runItemsByRun.get(row.run_id) ?? [];
    list.push(row.item_id);
    runItemsByRun.set(row.run_id, list);
  }
  const decisionsByRun = new Map<string, InformationDecision[]>();
  for (const row of database.prepare(
    "SELECT run_id, position, item_id, decision, reason FROM sms_decisions ORDER BY position",
  ).all() as DecisionRow[]) {
    const list = decisionsByRun.get(row.run_id) ?? [];
    list.push({ itemId: row.item_id, decision: row.decision, reason: row.reason });
    decisionsByRun.set(row.run_id, list);
  }
  const runs = (database.prepare(
    "SELECT id, position, status, created_at, started_at, finished_at, kind, model_status, model_error, has_decisions, publications_json FROM sms_runs ORDER BY position",
  ).all() as RunRow[]).map<InformationRun>((row) => ({
    id: row.id,
    itemIds: runItemsByRun.get(row.id) ?? [],
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.kind !== null ? { kind: row.kind } : {}),
    ...(row.model_status !== null
      ? { model: { status: row.model_status, ...(row.model_error !== null ? { error: row.model_error } : {}) } }
      : {}),
    ...(row.has_decisions === 1 ? { decisions: decisionsByRun.get(row.id) ?? [] } : {}),
    publications: parsePublications(row.publications_json),
  }));

  return {
    schemaVersion: stateRow.schema_version,
    settings: {
      enabled: stateRow.settings_enabled === 1,
      batchWindowSeconds: stateRow.settings_batch_window_seconds,
      mode: stateRow.settings_mode,
    },
    preferences: {
      learnedNotes: stateRow.preferences_learned_notes,
    },
    items,
    runs,
    articleFeedback,
    ...(stateRow.initial_analysis_completed === null
      ? {}
      : { initialAnalysisCompleted: stateRow.initial_analysis_completed === 1 }),
  };
};

const projectStateRow = (state: InformationState) => ({
  schema_version: state.schemaVersion,
  settings_enabled: state.settings.enabled ? 1 : 0,
  settings_batch_window_seconds: state.settings.batchWindowSeconds,
  settings_mode: state.settings.mode,
  preferences_learned_notes: state.preferences.learnedNotes,
  initial_analysis_completed: state.initialAnalysisCompleted === undefined
    ? null
    : state.initialAnalysisCompleted ? 1 : 0,
});

const projectItem = (item: InformationItem) => ({
  source: item.source,
  externalId: item.externalId,
  title: item.title ?? null,
  content: item.content,
  receivedAt: item.receivedAt,
  acceptedAt: item.acceptedAt,
  status: item.status,
  runId: item.runId ?? null,
  metadata: item.metadata ?? null,
});

const projectRun = (run: InformationRun) => ({
  status: run.status,
  createdAt: run.createdAt,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt ?? null,
  kind: run.kind ?? null,
  model: run.model ?? null,
  hasDecisions: run.decisions === undefined ? 0 : 1,
  publications: run.publications,
});

/**
 * 行级 diff 提交：previous 是本次事务前从库读回的聚合，next 是业务回调产生并
 * 严格校验后的新聚合。只增删改发生变化的行，不整表重写。
 */
export const applySmsState = (
  managed: ManagedSqliteDatabase,
  previous: InformationState,
  next: InformationState,
): void => {
  const database = managed.database;

  const prevStateRow = projectStateRow(previous);
  const nextStateRow = projectStateRow(next);
  if (canonicalJson(prevStateRow) !== canonicalJson(nextStateRow)) {
    database.prepare(
      "UPDATE sms_state SET schema_version = ?, settings_enabled = ?, settings_batch_window_seconds = ?, settings_mode = ?, preferences_learned_notes = ?, initial_analysis_completed = ? WHERE id = 1",
    ).run(
      nextStateRow.schema_version,
      nextStateRow.settings_enabled,
      nextStateRow.settings_batch_window_seconds,
      nextStateRow.settings_mode,
      nextStateRow.preferences_learned_notes,
      nextStateRow.initial_analysis_completed,
    );
  }

  const nextItemIds = new Set(next.items.map((item) => item.id));
  const nextFeedbackIds = new Set(next.articleFeedback.map((feedback) => feedback.itemId));
  const nextRunIds = new Set(next.runs.map((run) => run.id));
  const removedItemIds = previous.items.filter((item) => !nextItemIds.has(item.id));
  const removedFeedbackIds = previous.articleFeedback.filter((feedback) => !nextFeedbackIds.has(feedback.itemId));
  const removedRunIds = previous.runs.filter((run) => !nextRunIds.has(run.id));

  const prevCommentsByItem = new Map(previous.articleFeedback.map((feedback) => [feedback.itemId, feedback.comments]));
  const nextCommentsByItem = new Map(next.articleFeedback.map((feedback) => [feedback.itemId, feedback.comments]));
  const allCommentItemIds = new Set([...prevCommentsByItem.keys(), ...nextCommentsByItem.keys()]);

  // 删除阶段：评论 → 反馈 → run 明细/决定 → run → 条目。
  for (const itemId of allCommentItemIds) {
    const prevComments = prevCommentsByItem.get(itemId) ?? [];
    const nextComments = nextCommentsByItem.get(itemId) ?? [];
    for (const comment of prevComments) {
      if (!nextComments.some((candidate) => candidate.id === comment.id)) {
        database.prepare("DELETE FROM sms_feedback_comments WHERE id = ?").run(comment.id);
      }
    }
  }
  for (const feedback of removedFeedbackIds) {
    for (const comment of feedback.comments) {
      database.prepare("DELETE FROM sms_feedback_comments WHERE id = ?").run(comment.id);
    }
    database.prepare("DELETE FROM sms_feedback WHERE item_id = ?").run(feedback.itemId);
  }
  for (const run of removedRunIds) {
    database.prepare("DELETE FROM sms_run_items WHERE run_id = ?").run(run.id);
    database.prepare("DELETE FROM sms_decisions WHERE run_id = ?").run(run.id);
  }
  for (const run of removedRunIds) {
    database.prepare("DELETE FROM sms_runs WHERE id = ?").run(run.id);
  }
  for (const item of removedItemIds) {
    database.prepare("DELETE FROM sms_items WHERE id = ?").run(item.id);
  }

  // 写入阶段：条目 → run → run 明细/决定 → 反馈 → 评论。
  const prevItemById = new Map(previous.items.map((item, index) => [item.id, { item, index }]));
  next.items.forEach((item, index) => {
    const old = prevItemById.get(item.id);
    if (old && old.index === index && canonicalJson(projectItem(old.item)) === canonicalJson(projectItem(item))) return;
    database.prepare(
      "INSERT INTO sms_items (id, position, source, external_id, title, content, received_at, accepted_at, status, run_id, metadata_present, metadata_source_id, metadata_source_title, metadata_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, source = excluded.source, external_id = excluded.external_id, title = excluded.title, content = excluded.content, received_at = excluded.received_at, accepted_at = excluded.accepted_at, status = excluded.status, run_id = excluded.run_id, metadata_present = excluded.metadata_present, metadata_source_id = excluded.metadata_source_id, metadata_source_title = excluded.metadata_source_title, metadata_url = excluded.metadata_url",
    ).run(
      item.id,
      index,
      item.source,
      item.externalId,
      item.title ?? null,
      item.content,
      item.receivedAt,
      item.acceptedAt,
      item.status,
      item.runId ?? null,
      item.metadata ? 1 : 0,
      item.metadata?.sourceId ?? null,
      item.metadata?.sourceTitle ?? null,
      item.metadata?.url ?? null,
    );
  });

  const prevRunById = new Map(previous.runs.map((run, index) => [run.id, { run, index }]));
  next.runs.forEach((run, index) => {
    const old = prevRunById.get(run.id);
    const hasDecisions = run.decisions === undefined ? 0 : 1;
    const publicationsJson = canonicalJson(run.publications);
    const runRowChanged = !old ||
      old.index !== index ||
      canonicalJson(projectRun(old.run)) !== canonicalJson(projectRun(run));
    if (runRowChanged) {
      database.prepare(
        "INSERT INTO sms_runs (id, position, status, created_at, started_at, finished_at, kind, model_status, model_error, has_decisions, publications_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, status = excluded.status, created_at = excluded.created_at, started_at = excluded.started_at, finished_at = excluded.finished_at, kind = excluded.kind, model_status = excluded.model_status, model_error = excluded.model_error, has_decisions = excluded.has_decisions, publications_json = excluded.publications_json",
      ).run(
        run.id,
        index,
        run.status,
        run.createdAt,
        run.startedAt,
        run.finishedAt ?? null,
        run.kind ?? null,
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

  const prevFeedbackById = new Map(previous.articleFeedback.map((feedback, index) => [feedback.itemId, { feedback, index }]));
  next.articleFeedback.forEach((feedback, index) => {
    const old = prevFeedbackById.get(feedback.itemId);
    if (!old || old.index !== index || old.feedback.reaction !== feedback.reaction || old.feedback.saved !== feedback.saved) {
      database.prepare(
        "INSERT INTO sms_feedback (item_id, position, reaction, saved) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET position = excluded.position, reaction = excluded.reaction, saved = excluded.saved",
      ).run(feedback.itemId, index, feedback.reaction, feedback.saved ? 1 : 0);
    }
  });

  for (const [itemId, comments] of nextCommentsByItem) {
    const prevComments = prevCommentsByItem.get(itemId) ?? [];
    comments.forEach((comment, index) => {
      const old = prevComments.find((candidate) => candidate.id === comment.id);
      if (old &&
          prevComments.indexOf(old) === index &&
          old.text === comment.text &&
          old.createdAt === comment.createdAt &&
          old.updatedAt === comment.updatedAt) return;
      database.prepare(
        "INSERT INTO sms_feedback_comments (id, item_id, position, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET item_id = excluded.item_id, position = excluded.position, text = excluded.text, created_at = excluded.created_at, updated_at = excluded.updated_at",
      ).run(comment.id, itemId, index, comment.text, comment.createdAt, comment.updatedAt);
    });
  }
};
