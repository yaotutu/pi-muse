import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { informationStateSchema } from "./information-repository.js";
import type { ManagedSqliteDatabase } from "./sqlite-database.js";
import { newsSourceFailureCategories, type NewsSourceFailure } from "../../features/news/errors.js";
import {
  defaultNewsState,
  type NewsRepository,
  type NewsState,
  type NewsSource,
} from "../../features/news/types.js";
import type {
  InformationArticleFeedback,
  InformationDecision,
  InformationItem,
  InformationRun,
} from "../../features/information/types.js";

/**
 * news.sqlite 的表结构与行映射：
 * - 核心字段/关系（含文章来源快照与 URL）入列；run.publications 作为新闻
 *   正常不产生、但旧聚合允许的可变形状事实保留为规范 JSON payload 列。
 * - 读取只声明显式列：Agent 加列/加表不破坏严格解析；写入只 UPDATE/INSERT
 *   显式列，行级 diff 不整表重写，Agent 扩展数据不会被抹掉。
 * - 故意不加指向 news_sources 的外键：删除源必须保留文章与反馈。
 *   feedback/comments/run 明细/decisions 对文章、反馈、批次使用外键；
 *   已删除新闻源的 source_id/source 快照不引用 sources 表。
 * - 数组顺序（文章接纳序、反馈触达序、run itemIds/decisions 序）用
 *   position 列保真；游标分页的时间并列由 id 决胜，不依赖 position。
 */

const NEWS_SCHEMA_VERSION = 2;

const publicFeedUrl = z.string().url().max(2048).regex(/^https?:\/\//).refine((value) => {
  const url = new URL(value);
  const credentialKeys = ["username", "pass" + "word"] as const;
  return credentialKeys.every((key) => url[key as keyof URL] === "");
}, "URL must not contain credentials");

const sourceSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  title: z.string().min(1).max(500),
  url: publicFeedUrl,
  createdAt: z.string().datetime(),
  lastFetchedAt: z.string().datetime().nullable(),
  lastError: z.string().max(300).nullable(),
  lastErrorDetails: z.strictObject({
    category: z.enum(newsSourceFailureCategories),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }).nullable().optional(),
});

export const newsDocumentSchema = z.strictObject({
  processing: informationStateSchema,
  schemaVersion: z.literal(1),
  sources: z.array(sourceSchema),
  lastRefreshedAt: z.string().datetime().nullable(),
  lastError: z.string().max(300).nullable(),
});

/** 与旧 news.json 相同的严格校验；SQLite 写入前与读取后都执行同一规则。 */
export const parseNewsState = (value: unknown): NewsState => {
  const result = newsDocumentSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid news document");
  const state = result.data;
  const unique = (values: string[]): boolean => new Set(values).size === values.length;
  const items = new Set(state.processing.items.map((item) => item.id));
  if (!unique(state.sources.map((source) => source.id)) ||
      !unique(state.processing.items.map((item) => item.id)) ||
      !unique(state.processing.items.map((item) => JSON.stringify([item.source, item.externalId]))) ||
      !unique(state.processing.runs.map((run) => run.id)) ||
      !unique(state.processing.articleFeedback.map((feedback) => feedback.itemId)) ||
      !unique(state.processing.articleFeedback.flatMap((feedback) => feedback.comments.map((comment) => comment.id))) ||
      state.processing.articleFeedback.some((feedback) => !items.has(feedback.itemId)) ||
      state.processing.runs.some((run) => run.itemIds.some((id) => !items.has(id)) ||
        !unique(run.itemIds) ||
        !unique((run.decisions ?? []).map((decision) => decision.itemId)) ||
        run.decisions?.some((decision) => !run.itemIds.includes(decision.itemId)))) {
    throw new Error("Invalid news document: duplicate identity or invalid relation");
  }
  return state;
};

const NEWS_TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS news_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS news_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    settings_enabled INTEGER NOT NULL CHECK (settings_enabled IN (0, 1)),
    settings_batch_window_seconds INTEGER NOT NULL,
    settings_mode TEXT NOT NULL CHECK (settings_mode IN ('notifications', 'recommendations')),
    preferences_learned_notes TEXT NOT NULL,
    initial_analysis_completed INTEGER CHECK (initial_analysis_completed IN (0, 1)),
    last_refreshed_at TEXT,
    last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS news_sources (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_fetched_at TEXT,
    last_error TEXT,
    last_error_details TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS news_articles (
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
    source_id TEXT,
    source_title TEXT,
    article_url TEXT,
    UNIQUE (source, external_id)
  )`,
  `CREATE TABLE IF NOT EXISTS news_article_feedback (
    item_id TEXT PRIMARY KEY REFERENCES news_articles(id),
    position INTEGER NOT NULL,
    reaction TEXT CHECK (reaction IN ('like', 'dislike')),
    saved INTEGER NOT NULL CHECK (saved IN (0, 1))
  )`,
  `CREATE TABLE IF NOT EXISTS news_article_comments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES news_article_feedback(item_id),
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS news_analysis_runs (
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
  `CREATE TABLE IF NOT EXISTS news_analysis_run_items (
    run_id TEXT NOT NULL REFERENCES news_analysis_runs(id),
    position INTEGER NOT NULL,
    item_id TEXT NOT NULL REFERENCES news_articles(id),
    PRIMARY KEY (run_id, position)
  )`,
  `CREATE TABLE IF NOT EXISTS news_analysis_decisions (
    run_id TEXT NOT NULL REFERENCES news_analysis_runs(id),
    position INTEGER NOT NULL,
    item_id TEXT NOT NULL REFERENCES news_articles(id),
    decision TEXT NOT NULL CHECK (decision IN ('silent', 'notify')),
    reason TEXT NOT NULL,
    PRIMARY KEY (run_id, position)
  )`,
];

const NEWS_TABLES = [
  "news_meta",
  "news_state",
  "news_sources",
  "news_articles",
  "news_article_feedback",
  "news_article_comments",
  "news_analysis_runs",
  "news_analysis_run_items",
  "news_analysis_decisions",
] as const;

export const NEWS_META_ORIGIN_KEY = "news.origin";
const readMeta = (database: DatabaseSync, key: string): string | undefined => {
  const row = database.prepare("SELECT value FROM news_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
};

const tableExists = (database: DatabaseSync, table: string): boolean =>
  Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

const insertDefaultStateRow = (database: DatabaseSync): void => {
  const state = defaultNewsState();
  database.prepare(
    "INSERT INTO news_state (id, schema_version, settings_enabled, settings_batch_window_seconds, settings_mode, preferences_learned_notes, initial_analysis_completed, last_refreshed_at, last_error) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    state.schemaVersion,
    state.processing.settings.enabled ? 1 : 0,
    state.processing.settings.batchWindowSeconds,
    state.processing.settings.mode,
    state.processing.preferences.learnedNotes,
    state.processing.initialAnalysisCompleted === undefined ? null : state.processing.initialAnalysisCompleted ? 1 : 0,
    state.lastRefreshedAt,
    state.lastError,
  );
};

/**
 * 建库/校验结构。只有调用方确认本次新建的“空库”（user_version 0、无内置
 * 表、至多一个 header 页）才写入默认结构与来源标记；已初始化的库缺表、缺单例状态行或缺来源标记都视为结构损坏并显式
 * 失败——Agent 删表/清空状态不能被 CREATE IF NOT EXISTS 加默认值静默当成
 * 空新闻。整体在一个同步事务内完成，失败不落半初始化结构。
 */
export const ensureNewsSchema = (managed: ManagedSqliteDatabase, initialize = true): void => {
  managed.transaction(() => {
    const database = managed.database;
    const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number })?.user_version ?? 0);
    const existingTables = NEWS_TABLES.filter((table) => tableExists(database, table));
    const pageCount = Number((database.prepare("PRAGMA page_count").get() as { page_count: number })?.page_count ?? 0);
    const isEmptyDatabase = version === 0 && existingTables.length === 0 && pageCount <= 1;
    if (!initialize || !isEmptyDatabase) {
      if (version !== NEWS_SCHEMA_VERSION && version !== 1) {
        throw new Error(`Invalid news database: unsupported schema version ${version}`);
      }
      for (const table of NEWS_TABLES) {
        if (!existingTables.includes(table)) {
          throw new Error(`Invalid news database: missing table ${table}`);
        }
      }
      // v1→v2 是纯增列升级：只补可空的源失败分类，旧行保持 NULL（读取时省略字段）。
      if (version === 1) {
        const columns = database.prepare("PRAGMA table_info(news_sources)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "last_error_details")) {
          database.exec("ALTER TABLE news_sources ADD COLUMN last_error_details TEXT");
        }
        database.exec(`PRAGMA user_version = ${NEWS_SCHEMA_VERSION}`);
      }
      if (!database.prepare("SELECT 1 FROM news_state WHERE id = 1").get()) {
        throw new Error("Invalid news database: missing news_state row");
      }
      if (readMeta(database, NEWS_META_ORIGIN_KEY) !== "service") {
        throw new Error("Invalid news database: missing origin marker");
      }
      return;
    }
    for (const statement of NEWS_TABLE_DDL) database.exec(statement);
    database.exec(`PRAGMA user_version = ${NEWS_SCHEMA_VERSION}`);
    insertDefaultStateRow(database);
    database.prepare("INSERT INTO news_meta (key, value) VALUES (?, ?)").run(NEWS_META_ORIGIN_KEY, "service");
  });
};

const parsePayload = (raw: string | null, label: string): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid news database: corrupted ${label}`);
  }
};

/**
 * 源失败分类的可选列：SQL NULL 表示旧库/旧行从未写入分类（读取时省略字段），
 * 文本 null 表示成功抓取后显式清空（读取时保留 null）。
 */
const parseSourceDetails = (raw: string | null): NewsSourceFailure | null | undefined =>
  raw === null ? undefined : parsePayload(raw, "source error details") as NewsSourceFailure | null;

const sourceDetailsJson = (source: NewsSource): string | null =>
  source.lastErrorDetails === undefined ? null : JSON.stringify(source.lastErrorDetails);

type SourceRow = {
  id: string; position: number; title: string; url: string;
  created_at: string; last_fetched_at: string | null; last_error: string | null;
  last_error_details: string | null;
};
type ArticleRow = {
  id: string; position: number; source: string; external_id: string; title: string | null;
  content: string; received_at: string; accepted_at: string; status: InformationItem["status"];
  run_id: string | null; metadata_present: number; source_id: string | null; source_title: string | null; article_url: string | null;
};
type FeedbackRow = { item_id: string; position: number; reaction: "like" | "dislike" | null; saved: number };
type CommentRow = { id: string; item_id: string; position: number; text: string; created_at: string; updated_at: string };
type RunRow = {
  id: string; position: number; status: InformationRun["status"]; created_at: string; started_at: string;
  finished_at: string | null; kind: InformationRun["kind"] | null; model_status: "succeeded" | "failed" | null;
  model_error: string | null; has_decisions: number; publications_json: string;
};
type RunItemRow = { run_id: string; position: number; item_id: string };
type DecisionRow = { run_id: string; position: number; item_id: string; decision: "silent" | "notify"; reason: string };
type StateRow = {
  schema_version: number; settings_enabled: number; settings_batch_window_seconds: number;
  settings_mode: "notifications" | "recommendations"; preferences_learned_notes: string;
  initial_analysis_completed: number | null; last_refreshed_at: string | null; last_error: string | null;
};

/** 从显式列装配完整 NewsState 聚合，并按旧 JSON 文档同一规则严格校验。 */
export const readNewsState = (managed: ManagedSqliteDatabase): NewsState => {
  const database = managed.database;
  const stateRow = database.prepare(
    "SELECT schema_version, settings_enabled, settings_batch_window_seconds, settings_mode, preferences_learned_notes, initial_analysis_completed, last_refreshed_at, last_error FROM news_state WHERE id = 1",
  ).get() as StateRow | undefined;
  if (!stateRow) throw new Error("Invalid news database: missing news_state row");
  const sources = (database.prepare(
    "SELECT id, position, title, url, created_at, last_fetched_at, last_error, last_error_details FROM news_sources ORDER BY position",
  ).all() as SourceRow[]).map<NewsSource>((row) => {
    const lastErrorDetails = parseSourceDetails(row.last_error_details);
    return {
      id: row.id,
      title: row.title,
      url: row.url,
      createdAt: row.created_at,
      lastFetchedAt: row.last_fetched_at,
      lastError: row.last_error,
      ...(lastErrorDetails === undefined ? {} : { lastErrorDetails }),
    };
  });
  const items = (database.prepare(
    "SELECT id, position, source, external_id, title, content, received_at, accepted_at, status, run_id, metadata_present, source_id, source_title, article_url FROM news_articles ORDER BY position",
  ).all() as ArticleRow[]).map<InformationItem>((row) => ({
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    ...(row.title !== null ? { title: row.title } : {}),
    content: row.content,
    receivedAt: row.received_at,
    acceptedAt: row.accepted_at,
    status: row.status,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    ...(row.metadata_present === 1 ? { metadata: { sourceId: row.source_id!, sourceTitle: row.source_title!, url: row.article_url } } : {}),
  }));
  const commentsByItem = new Map<string, InformationArticleFeedback["comments"]>();
  for (const row of database.prepare(
    "SELECT id, item_id, position, text, created_at, updated_at FROM news_article_comments ORDER BY position",
  ).all() as CommentRow[]) {
    const list = commentsByItem.get(row.item_id) ?? [];
    list.push({ id: row.id, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at });
    commentsByItem.set(row.item_id, list);
  }
  const articleFeedback = (database.prepare(
    "SELECT item_id, position, reaction, saved FROM news_article_feedback ORDER BY position",
  ).all() as FeedbackRow[]).map<InformationArticleFeedback>((row) => ({
    itemId: row.item_id,
    reaction: row.reaction,
    saved: row.saved === 1,
    comments: commentsByItem.get(row.item_id) ?? [],
  }));
  const runItemsByRun = new Map<string, string[]>();
  for (const row of database.prepare(
    "SELECT run_id, position, item_id FROM news_analysis_run_items ORDER BY position",
  ).all() as RunItemRow[]) {
    const list = runItemsByRun.get(row.run_id) ?? [];
    list.push(row.item_id);
    runItemsByRun.set(row.run_id, list);
  }
  const decisionsByRun = new Map<string, InformationDecision[]>();
  for (const row of database.prepare(
    "SELECT run_id, position, item_id, decision, reason FROM news_analysis_decisions ORDER BY position",
  ).all() as DecisionRow[]) {
    const list = decisionsByRun.get(row.run_id) ?? [];
    list.push({ itemId: row.item_id, decision: row.decision, reason: row.reason });
    decisionsByRun.set(row.run_id, list);
  }
  const runs = (database.prepare(
    "SELECT id, position, status, created_at, started_at, finished_at, kind, model_status, model_error, has_decisions, publications_json FROM news_analysis_runs ORDER BY position",
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
    publications: parsePayload(row.publications_json, "run publications") as InformationRun["publications"],
  }));
  const processing = {
    schemaVersion: 1,
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
  return parseNewsState({
    processing,
    schemaVersion: stateRow.schema_version,
    sources,
    lastRefreshedAt: stateRow.last_refreshed_at,
    lastError: stateRow.last_error,
  });
};

/** 稳定 key 序列化：同一逻辑 payload 不因对象 key 顺序产生不同存储字节。 */
const canonicalJson = (value: unknown): string => {
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

export const deepEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => key in (right as Record<string, unknown>) &&
      deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
};

const projectStateRow = (state: NewsState) => ({
  schema_version: state.schemaVersion,
  settings_enabled: state.processing.settings.enabled ? 1 : 0,
  settings_batch_window_seconds: state.processing.settings.batchWindowSeconds,
  settings_mode: state.processing.settings.mode,
  preferences_learned_notes: state.processing.preferences.learnedNotes,
  initial_analysis_completed: state.processing.initialAnalysisCompleted === undefined
    ? null
    : state.processing.initialAnalysisCompleted ? 1 : 0,
  last_refreshed_at: state.lastRefreshedAt,
  last_error: state.lastError,
});

/**
 * 行级 diff 提交：prev 是本次事务前从库读回的聚合，next 是业务回调产生并
 * 严格校验后的新聚合。只增删改发生变化的行，不整表重写；删除顺序先子后父，
 * 写入顺序先父后子，满足外键。
 */
export const applyNewsState = (managed: ManagedSqliteDatabase, previous: NewsState, next: NewsState): void => {
  const database = managed.database;

  const prevStateRow = projectStateRow(previous);
  const nextStateRow = projectStateRow(next);
  if (!deepEqual(prevStateRow, nextStateRow)) {
    database.prepare(
      "UPDATE news_state SET schema_version = ?, settings_enabled = ?, settings_batch_window_seconds = ?, settings_mode = ?, preferences_learned_notes = ?, initial_analysis_completed = ?, last_refreshed_at = ?, last_error = ? WHERE id = 1",
    ).run(
      nextStateRow.schema_version,
      nextStateRow.settings_enabled,
      nextStateRow.settings_batch_window_seconds,
      nextStateRow.settings_mode,
      nextStateRow.preferences_learned_notes,
      nextStateRow.initial_analysis_completed,
      nextStateRow.last_refreshed_at,
      nextStateRow.last_error,
    );
  }

  // 历史文章会持续增长，移除检测用集合，避免每次反馈写入都做全量平方级扫描。
  const nextSourceIds = new Set(next.sources.map((source) => source.id));
  const nextArticleIds = new Set(next.processing.items.map((item) => item.id));
  const nextFeedbackIds = new Set(next.processing.articleFeedback.map((feedback) => feedback.itemId));
  const nextRunIds = new Set(next.processing.runs.map((run) => run.id));
  const removedSourceIds = previous.sources.filter((source) => !nextSourceIds.has(source.id));
  const removedArticleIds = previous.processing.items.filter((item) => !nextArticleIds.has(item.id));
  const removedFeedbackIds = previous.processing.articleFeedback.filter((feedback) => !nextFeedbackIds.has(feedback.itemId));
  const removedRunIds = previous.processing.runs.filter((run) => !nextRunIds.has(run.id));

  const prevCommentsByItem = new Map(previous.processing.articleFeedback.map((feedback) => [feedback.itemId, feedback.comments]));
  const nextCommentsByItem = new Map(next.processing.articleFeedback.map((feedback) => [feedback.itemId, feedback.comments]));
  const allCommentItemIds = new Set([...prevCommentsByItem.keys(), ...nextCommentsByItem.keys()]);

  // 删除阶段：评论 → 反馈 → run 明细/决策 → run → 文章 → 源。
  for (const itemId of allCommentItemIds) {
    const prevComments = prevCommentsByItem.get(itemId) ?? [];
    const nextComments = nextCommentsByItem.get(itemId) ?? [];
    for (const comment of prevComments) {
      if (!nextComments.some((candidate) => candidate.id === comment.id)) {
        database.prepare("DELETE FROM news_article_comments WHERE id = ?").run(comment.id);
      }
    }
  }
  for (const feedback of removedFeedbackIds) {
    for (const comment of feedback.comments) {
      database.prepare("DELETE FROM news_article_comments WHERE id = ?").run(comment.id);
    }
    database.prepare("DELETE FROM news_article_feedback WHERE item_id = ?").run(feedback.itemId);
  }
  for (const run of removedRunIds) {
    database.prepare("DELETE FROM news_analysis_run_items WHERE run_id = ?").run(run.id);
    database.prepare("DELETE FROM news_analysis_decisions WHERE run_id = ?").run(run.id);
  }
  for (const run of removedRunIds) {
    database.prepare("DELETE FROM news_analysis_runs WHERE id = ?").run(run.id);
  }
  for (const item of removedArticleIds) {
    database.prepare("DELETE FROM news_articles WHERE id = ?").run(item.id);
  }
  for (const source of removedSourceIds) {
    database.prepare("DELETE FROM news_sources WHERE id = ?").run(source.id);
  }

  // 写入阶段：文章 → run → 反馈 → 评论 → run 明细/决策 → 源。
  const prevArticleById = new Map(previous.processing.items.map((item, index) => [item.id, { item, index }]));
  next.processing.items.forEach((item, index) => {
    const old = prevArticleById.get(item.id);
    const payload = canonicalJson(item.metadata ?? null);
    if (old &&
        old.index === index &&
        old.item.source === item.source &&
        old.item.externalId === item.externalId &&
        old.item.title === item.title &&
        old.item.content === item.content &&
        old.item.receivedAt === item.receivedAt &&
        old.item.acceptedAt === item.acceptedAt &&
        old.item.status === item.status &&
        old.item.runId === item.runId &&
        canonicalJson(old.item.metadata ?? null) === payload) return;
    database.prepare(
      "INSERT INTO news_articles (id, position, source, external_id, title, content, received_at, accepted_at, status, run_id, metadata_present, source_id, source_title, article_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, source = excluded.source, external_id = excluded.external_id, title = excluded.title, content = excluded.content, received_at = excluded.received_at, accepted_at = excluded.accepted_at, status = excluded.status, run_id = excluded.run_id, metadata_present = excluded.metadata_present, source_id = excluded.source_id, source_title = excluded.source_title, article_url = excluded.article_url",
    ).run(item.id, index, item.source, item.externalId, item.title ?? null, item.content, item.receivedAt, item.acceptedAt, item.status, item.runId ?? null, item.metadata ? 1 : 0, item.metadata?.sourceId ?? null, item.metadata?.sourceTitle ?? null, item.metadata?.url ?? null);
  });

  const prevRunById = new Map(previous.processing.runs.map((run, index) => [run.id, { run, index }]));
  next.processing.runs.forEach((run, index) => {
    const old = prevRunById.get(run.id);
    const publicationsJson = canonicalJson(run.publications);
    const hasDecisions = run.decisions === undefined ? 0 : 1;
    const runRowChanged = !old ||
      old.index !== index ||
      old.run.status !== run.status ||
      old.run.createdAt !== run.createdAt ||
      old.run.startedAt !== run.startedAt ||
      old.run.finishedAt !== run.finishedAt ||
      old.run.kind !== run.kind ||
      (old.run.model?.status ?? null) !== (run.model?.status ?? null) ||
      (old.run.model?.error ?? null) !== (run.model?.error ?? null) ||
      (old.run.decisions === undefined ? 0 : 1) !== hasDecisions ||
      canonicalJson(old.run.publications) !== publicationsJson;
    if (runRowChanged) {
      database.prepare(
        "INSERT INTO news_analysis_runs (id, position, status, created_at, started_at, finished_at, kind, model_status, model_error, has_decisions, publications_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, status = excluded.status, created_at = excluded.created_at, started_at = excluded.started_at, finished_at = excluded.finished_at, kind = excluded.kind, model_status = excluded.model_status, model_error = excluded.model_error, has_decisions = excluded.has_decisions, publications_json = excluded.publications_json",
      ).run(run.id, index, run.status, run.createdAt, run.startedAt, run.finishedAt ?? null, run.kind ?? null, run.model?.status ?? null, run.model?.error ?? null, hasDecisions, publicationsJson);
    }
    if (!old || !deepEqual(old.run.itemIds, run.itemIds)) {
      for (let position = run.itemIds.length; position < (old?.run.itemIds.length ?? 0); position++) {
        database.prepare("DELETE FROM news_analysis_run_items WHERE run_id = ? AND position = ?").run(run.id, position);
      }
      run.itemIds.forEach((itemId, itemIndex) => {
        if (old?.run.itemIds[itemIndex] === itemId) return;
        database.prepare("INSERT INTO news_analysis_run_items (run_id, position, item_id) VALUES (?, ?, ?) ON CONFLICT(run_id, position) DO UPDATE SET item_id = excluded.item_id").run(run.id, itemIndex, itemId);
      });
    }
    if (!old || !deepEqual(old.run.decisions ?? null, run.decisions ?? null)) {
      const decisions = run.decisions ?? [];
      for (let position = decisions.length; position < (old?.run.decisions?.length ?? 0); position++) {
        database.prepare("DELETE FROM news_analysis_decisions WHERE run_id = ? AND position = ?").run(run.id, position);
      }
      decisions.forEach((decision, decisionIndex) => {
        if (deepEqual(old?.run.decisions?.[decisionIndex], decision)) return;
        database.prepare(
          "INSERT INTO news_analysis_decisions (run_id, position, item_id, decision, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, position) DO UPDATE SET item_id = excluded.item_id, decision = excluded.decision, reason = excluded.reason",
        ).run(run.id, decisionIndex, decision.itemId, decision.decision, decision.reason);
      });
    }
  });

  const prevFeedbackById = new Map(previous.processing.articleFeedback.map((feedback, index) => [feedback.itemId, { feedback, index }]));
  next.processing.articleFeedback.forEach((feedback, index) => {
    const old = prevFeedbackById.get(feedback.itemId);
    if (!old || old.index !== index || old.feedback.reaction !== feedback.reaction || old.feedback.saved !== feedback.saved) {
      database.prepare(
        "INSERT INTO news_article_feedback (item_id, position, reaction, saved) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET position = excluded.position, reaction = excluded.reaction, saved = excluded.saved",
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
        "INSERT INTO news_article_comments (id, item_id, position, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET item_id = excluded.item_id, position = excluded.position, text = excluded.text, created_at = excluded.created_at, updated_at = excluded.updated_at",
      ).run(comment.id, itemId, index, comment.text, comment.createdAt, comment.updatedAt);
    });
  }

  const prevSourceById = new Map(previous.sources.map((source, index) => [source.id, { source, index }]));
  next.sources.forEach((source, index) => {
    const old = prevSourceById.get(source.id);
    if (old &&
        old.index === index &&
        old.source.title === source.title &&
        old.source.url === source.url &&
        old.source.createdAt === source.createdAt &&
        old.source.lastFetchedAt === source.lastFetchedAt &&
        old.source.lastError === source.lastError &&
        sourceDetailsJson(old.source) === sourceDetailsJson(source)) return;
    database.prepare(
      "INSERT INTO news_sources (id, position, title, url, created_at, last_fetched_at, last_error, last_error_details) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET position = excluded.position, title = excluded.title, url = excluded.url, created_at = excluded.created_at, last_fetched_at = excluded.last_fetched_at, last_error = excluded.last_error, last_error_details = excluded.last_error_details",
    ).run(source.id, index, source.title, source.url, source.createdAt, source.lastFetchedAt, source.lastError, sourceDetailsJson(source));
  });
};

export type NewsRepositoryHandle = { repository: NewsRepository; database: ManagedSqliteDatabase };
