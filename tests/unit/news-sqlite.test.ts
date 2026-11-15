import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importLegacyNewsJson } from "../../src/adapters/storage/news-import.js";
import {
  LegacyNewsImportRequiredError,
  openNewsRepository,
} from "../../src/adapters/storage/news-repository.js";
import { ensureNewsSchema, parseNewsState } from "../../src/adapters/storage/news-schema.js";
import { openSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { defaultNewsState } from "../../src/features/news/types.js";
import type { InformationItem } from "../../src/features/information/types.js";

const TIMESTAMP = "2026-11-01T08:00:00.000Z";

const article = (id: string, overrides: Partial<InformationItem> = {}): InformationItem => ({
  id,
  source: "newssource_kept",
  externalId: `ext-${id}`,
  title: `Title ${id}`,
  content: `Content ${id}`,
  receivedAt: TIMESTAMP,
  acceptedAt: TIMESTAMP,
  status: "processed",
  metadata: { sourceId: "newssource_kept", sourceTitle: "Kept Feed", url: `https://example.com/${id}` },
  ...overrides,
});

/** 覆盖被删源文章、取消反馈、相同时间 run 顺序、重跑批次与投递 payload 的合成旧文档。 */
const legacyDocument = () => ({
  processing: {
    schemaVersion: 1,
    settings: { enabled: true, batchWindowSeconds: 0, mode: "recommendations" },
    preferences: { notes: "prefer primary sources", learnedNotes: "values releases" },
    items: [
      article("info_kept_1", { runId: "inforun_1" }),
      article("info_gone_1", {
        runId: "inforun_1",
        metadata: { sourceId: "newssource_deleted", sourceTitle: "Deleted Feed", url: null },
      }),
      article("info_pending_1", { status: "pending", title: undefined, metadata: { sourceId: "newssource_kept", sourceTitle: "Kept Feed", url: null } }),
    ],
    runs: [
      {
        id: "inforun_1",
        itemIds: ["info_kept_1", "info_gone_1"],
        status: "completed",
        createdAt: TIMESTAMP,
        startedAt: TIMESTAMP,
        finishedAt: TIMESTAMP,
        kind: "incremental",
        model: { status: "succeeded" },
        decisions: [
          { itemId: "info_kept_1", decision: "notify", reason: "substantive" },
          { itemId: "info_gone_1", decision: "silent", reason: "routine" },
        ],
        publications: [],
      },
      {
        id: "inforun_2",
        itemIds: ["info_pending_1"],
        status: "failed",
        createdAt: TIMESTAMP,
        startedAt: TIMESTAMP,
        finishedAt: TIMESTAMP,
        kind: "incremental",
        model: { status: "failed", error: "model down" },
        publications: [
          { notificationId: "n1", itemIds: ["info_kept_1"], text: "digest", status: "published", receipt: { notificationId: "n1", piSessionId: "pi_1", messageId: "msg_1" } },
          { notificationId: "n2", itemIds: ["info_gone_1"], text: "digest2", status: "failed", error: "delivery failed" },
        ],
      },
    ],
    articleFeedback: [
      { itemId: "info_kept_1", reaction: null, saved: false, comments: [] },
      {
        itemId: "info_gone_1",
        reaction: "dislike",
        saved: true,
        comments: [{ id: "comment_1", text: "useful context", createdAt: TIMESTAMP, updatedAt: TIMESTAMP }],
      },
    ],
    initialAnalysisCompleted: true,
  },
  schemaVersion: 1,
  sources: [
    {
      id: "newssource_kept",
      title: "Kept Feed",
      url: "https://example.com/feed.xml",
      createdAt: TIMESTAMP,
      lastFetchedAt: TIMESTAMP,
      lastError: null,
    },
  ],
  lastRefreshedAt: TIMESTAMP,
  lastError: null,
});

const tempDirectory = async (prefix: string) => mkdtemp(join(tmpdir(), `${prefix}-`));

test("sqlite news repository round-trips the aggregate and persists across reopen", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-roundtrip");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "news.sqlite");
  const legacyJsonFile = join(directory, "news.json");
  const document = legacyDocument();
  const expected = parseNewsState(JSON.parse(JSON.stringify(document)));

  const first = await openNewsRepository({ databaseFile, legacyJsonFile });
  await first.repository.update((state) => {
    assert.deepEqual(state, defaultNewsState(), "fresh database starts as the default news state");
    return { state: expected, result: undefined };
  });
  assert.deepEqual(await first.repository.read(), expected);
  // decisions 缺省与空数组是两种合法形状，必须原样保留。
  assert.equal("decisions" in (await first.repository.read()).processing.runs[1]!, false);
  assert.deepEqual((await first.repository.read()).processing.runs[0]!.decisions?.length, 2);
  assert.equal("title" in (await first.repository.read()).processing.items[2]!, false);
  await first.database.close();

  const second = await openNewsRepository({ databaseFile, legacyJsonFile });
  t.after(() => second.database.close());
  assert.deepEqual(await second.repository.read(), expected);
});

test("row-level diff keeps agent-added columns and tables without rewriting untouched rows", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-agent");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handle = await openNewsRepository({
    databaseFile: join(directory, "news.sqlite"),
    legacyJsonFile: join(directory, "news.json"),
  });
  t.after(() => handle.database.close());
  const { repository } = handle;
  const database = handle.database.database;
  await repository.update((state) => ({
    state: {
      ...state,
      processing: { ...state.processing, items: [article("info_a"), article("info_b", { status: "failed" })] },
    },
    result: undefined,
  }));

  // Agent 扩展：附加列、自建表与 UPDATE 审计触发器。
  database.exec("ALTER TABLE news_articles ADD COLUMN agent_note TEXT");
  database.prepare("UPDATE news_articles SET agent_note = ? WHERE id = ?").run("keep-me", "info_a");
  database.exec("CREATE TABLE agent_extra (id TEXT PRIMARY KEY)");
  database.prepare("INSERT INTO agent_extra (id) VALUES (?)").run("mine");
  database.exec(
    "CREATE TABLE agent_audit (id TEXT);" +
    "CREATE TRIGGER news_articles_after_update AFTER UPDATE ON news_articles" +
    " BEGIN INSERT INTO agent_audit (id) VALUES (NEW.id); END",
  );

  // 只改全局刷新时间的提交不应触碰任何文章行。
  await repository.update((state) => ({ state: { ...state, lastRefreshedAt: TIMESTAMP }, result: undefined }));
  assert.deepEqual(database.prepare("SELECT id FROM agent_audit").all(), []);
  assert.equal(
    (database.prepare("SELECT agent_note FROM news_articles WHERE id = 'info_a'").get() as { agent_note: string }).agent_note,
    "keep-me",
  );
  assert.equal((database.prepare("SELECT id FROM agent_extra").get() as { id: string }).id, "mine");

  // 状态翻转只重写发生变化的行。
  await repository.update((state) => ({
    state: {
      ...state,
      processing: {
        ...state.processing,
        items: state.processing.items.map((item) => item.id === "info_b" ? { ...item, status: "pending" as const } : item),
      },
    },
    result: undefined,
  }));
  assert.deepEqual(
    database.prepare("SELECT id FROM agent_audit").all().map((row) => (row as { id: string }).id),
    ["info_b"],
  );
  assert.equal(
    (database.prepare("SELECT agent_note FROM news_articles WHERE id = 'info_a'").get() as { agent_note: string }).agent_note,
    "keep-me",
  );
});

test("feedback recency order, comment order and same-timestamp articles keep their stored order", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-order");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handle = await openNewsRepository({
    databaseFile: join(directory, "news.sqlite"),
    legacyJsonFile: join(directory, "news.json"),
  });
  t.after(() => handle.database.close());
  const { repository } = handle;
  await repository.update((state) => ({
    state: {
      ...state,
      processing: {
        ...state.processing,
        items: [article("info_a"), article("info_b"), article("info_c")],
        articleFeedback: [
          { itemId: "info_a", reaction: "like", saved: false, comments: [] },
          { itemId: "info_b", reaction: null, saved: false, comments: [] },
          {
            itemId: "info_c",
            reaction: null,
            saved: false,
            comments: [
              { id: "comment_1", text: "first", createdAt: TIMESTAMP, updatedAt: TIMESTAMP },
              { id: "comment_2", text: "second", createdAt: TIMESTAMP, updatedAt: TIMESTAMP },
            ],
          },
        ],
      },
    },
    result: undefined,
  }));
  // 模拟 updateArticle 的触达语义：把最早的文章反馈移动到末尾。
  await repository.update((state) => {
    const touched = state.processing.articleFeedback.find((feedback) => feedback.itemId === "info_a")!;
    return {
      state: {
        ...state,
        processing: {
          ...state.processing,
          articleFeedback: [
            ...state.processing.articleFeedback.filter((feedback) => feedback.itemId !== "info_a"),
            { ...touched, reaction: "dislike" },
          ],
        },
      },
      result: undefined,
    };
  });
  const read = await repository.read();
  assert.deepEqual(read.processing.articleFeedback.map((feedback) => feedback.itemId), ["info_b", "info_c", "info_a"]);
  assert.equal(read.processing.articleFeedback[2]!.reaction, "dislike");
  assert.deepEqual(
    read.processing.articleFeedback.find((feedback) => feedback.itemId === "info_c")!.comments.map((c) => c.id),
    ["comment_1", "comment_2"],
  );
  // 同一 receivedAt/acceptedAt 的文章保持接纳顺序。
  assert.deepEqual(read.processing.items.map((item) => item.id), ["info_a", "info_b", "info_c"]);
  await repository.update((state) => ({
    state: {
      ...state,
      processing: {
        ...state.processing,
        articleFeedback: state.processing.articleFeedback.map((feedback) => feedback.itemId === "info_c"
          ? { ...feedback, comments: feedback.comments.filter((comment) => comment.id !== "comment_1") }
          : feedback),
      },
    },
    result: undefined,
  }));
  assert.deepEqual(
    (await repository.read()).processing.articleFeedback.find((feedback) => feedback.itemId === "info_c")!.comments.map((c) => c.id),
    ["comment_2"],
  );
});

test("update callback failures leave the database untouched and strict parsing rejects corrupted rows", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-strict");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handle = await openNewsRepository({
    databaseFile: join(directory, "news.sqlite"),
    legacyJsonFile: join(directory, "news.json"),
  });
  t.after(() => handle.database.close());
  const { repository } = handle;
  const database = handle.database.database;
  await repository.update((state) => ({
    state: { ...state, processing: { ...state.processing, items: [article("info_a")] } },
    result: undefined,
  }));
  await assert.rejects(
    repository.update(() => { throw new Error("conflict-marker"); }),
    /conflict-marker/,
  );
  assert.deepEqual((await repository.read()).processing.items.map((item) => item.id), ["info_a"]);
  // Agent 直接写坏数据必须在读取时暴露，不能被静默过滤。
  database.prepare("UPDATE news_articles SET content = ? WHERE id = ?").run("", "info_a");
  await assert.rejects(repository.read(), /Invalid news document/);
});

test("startup demands explicit import when legacy news.json carries data", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-legacy");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "news.sqlite");
  const legacyJsonFile = join(directory, "news.json");
  await writeFile(legacyJsonFile, JSON.stringify(legacyDocument(), null, 2), { mode: 0o600 });
  await assert.rejects(openNewsRepository({ databaseFile, legacyJsonFile }), (error: unknown) => {
    assert.ok(error instanceof LegacyNewsImportRequiredError);
    assert.match(error.message, /explicit import/i);
    return true;
  });
  await assert.rejects(stat(databaseFile), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("legacy presence blocks startup without reading it; explicit import reports corrupt JSON", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-corrupt-legacy");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyJsonFile = join(directory, "news.json");
  await writeFile(legacyJsonFile, "{invalid", { mode: 0o600 });
  await assert.rejects(
    openNewsRepository({ databaseFile: join(directory, "news.sqlite"), legacyJsonFile }),
    LegacyNewsImportRequiredError,
  );
  await assert.rejects(importLegacyNewsJson({ sourceFile: legacyJsonFile, databaseFile: join(directory, "news.sqlite") }), /Invalid news document/);
});

test("even a vacant legacy news.json requires explicit import", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-vacant");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyJsonFile = join(directory, "news.json");
  await writeFile(legacyJsonFile, JSON.stringify(defaultNewsState(), null, 2), { mode: 0o600 });
  await assert.rejects(openNewsRepository({
    databaseFile: join(directory, "news.sqlite"),
    legacyJsonFile,
  }), LegacyNewsImportRequiredError);
});

test("service-initialized database refuses to silently mix later-appearing legacy data", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-mixed");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "news.sqlite");
  const legacyJsonFile = join(directory, "news.json");
  const first = await openNewsRepository({ databaseFile, legacyJsonFile });
  await first.database.close();
  await writeFile(legacyJsonFile, JSON.stringify(legacyDocument(), null, 2), { mode: 0o600 });
  await assert.rejects(openNewsRepository({ databaseFile, legacyJsonFile }), LegacyNewsImportRequiredError);
});

test("a v1 news database upgrades in place by adding optional source failure details", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-upgrade");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "news.sqlite");
  const legacyJsonFile = join(directory, "news.json");
  const first = await openNewsRepository({ databaseFile, legacyJsonFile });
  await first.repository.update((state) => ({
    state: {
      ...state,
      sources: [{
        id: "newssource_legacy", title: "Legacy", url: "https://example.com/feed.xml",
        createdAt: TIMESTAMP, lastFetchedAt: null, lastError: "RSS source fetch or parse failed",
      }],
    },
    result: undefined,
  }));
  await first.database.close();
  const raw = await openSqliteDatabase(databaseFile);
  raw.database.exec("ALTER TABLE news_sources DROP COLUMN last_error_details");
  raw.database.exec("PRAGMA user_version = 1");
  await raw.close();

  const upgraded = await openNewsRepository({ databaseFile, legacyJsonFile });
  try {
    assert.equal(
      (upgraded.database.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      2,
    );
    const columns = upgraded.database.database.prepare("PRAGMA table_info(news_sources)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "last_error_details"));
    const source = (await upgraded.repository.read()).sources[0]!;
    assert.equal(source.lastError, "RSS source fetch or parse failed");
    assert.equal(Object.hasOwn(source, "lastErrorDetails"), false, "legacy rows keep the field absent");
  } finally {
    await upgraded.database.close();
  }
});

test("structural damage to an initialized news database fails startup explicitly", async (t) => {
  const damages = [
    { statement: "DROP TABLE news_article_comments", message: /missing table news_article_comments/ },
    { statement: "DELETE FROM news_state", message: /missing news_state row/ },
    { statement: "DELETE FROM news_meta WHERE key = 'news.origin'", message: /missing origin marker/ },
  ] as const;
  for (const damage of damages) {
    const directory = await tempDirectory("pi-muse-news-sqlite-damage");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const databaseFile = join(directory, "news.sqlite");
    const legacyJsonFile = join(directory, "news.json");
    const handle = await openNewsRepository({ databaseFile, legacyJsonFile });
    await handle.database.close();
    const raw = await openSqliteDatabase(databaseFile);
    raw.database.exec(damage.statement);
    await raw.close();
    await assert.rejects(openNewsRepository({ databaseFile, legacyJsonFile }), damage.message);
  }
});

test("an existing zero-byte database is not silently reinitialized", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-empty-file");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = join(directory, "news.sqlite");
  await writeFile(databaseFile, "", { mode: 0o600 });
  await assert.rejects(openNewsRepository({ databaseFile, legacyJsonFile: join(directory, "news.json") }), /unsupported schema version 0/);
});

test("an interrupted import cannot publish its initialized empty schema as valid news", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-import-interrupted");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceFile = join(directory, "news.json");
  const databaseFile = join(directory, "news.sqlite");
  const sourceText = JSON.stringify(legacyDocument());
  await writeFile(sourceFile, sourceText, { mode: 0o600 });
  const managed = await openSqliteDatabase(databaseFile);
  await managed.serialize(() => ensureNewsSchema(managed, { origin: "imported", source: sourceFile, importedAt: TIMESTAMP }));
  await managed.close();
  await assert.rejects(openNewsRepository({ databaseFile, legacyJsonFile: sourceFile }), /unfinished import/);
  assert.equal(await readFile(sourceFile, "utf8"), sourceText);
});

test("an imported SQLite database remains authoritative without reparsing the retained JSON backup", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-sole-authority");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceFile = join(directory, "news.json");
  const databaseFile = join(directory, "news.sqlite");
  await writeFile(sourceFile, JSON.stringify(legacyDocument()), { mode: 0o600 });
  await importLegacyNewsJson({ sourceFile, databaseFile });
  await writeFile(sourceFile, "not active business data anymore", { mode: 0o600 });
  const handle = await openNewsRepository({ databaseFile, legacyJsonFile: sourceFile });
  try { assert.equal((await handle.repository.read()).processing.items.length, 3); }
  finally { await handle.database.close(); }
});

test("article identity is enforced by SQLite even for direct SQL writes", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-unique");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handle = await openNewsRepository({ databaseFile: join(directory, "news.sqlite"), legacyJsonFile: join(directory, "news.json") });
  try {
    await handle.repository.update(() => ({ state: parseNewsState(legacyDocument()), result: undefined }));
    await assert.rejects(handle.database.serialize(() => handle.database.database.exec(
      "INSERT INTO news_articles (id, position, source, external_id, title, content, received_at, accepted_at, status, run_id, metadata_present, source_id, source_title, article_url) " +
      "SELECT 'info_duplicate', 99, source, external_id, title, content, received_at, accepted_at, status, run_id, metadata_present, source_id, source_title, article_url FROM news_articles WHERE id = 'info_kept_1'",
    )), /UNIQUE/);
    assert.equal((await handle.repository.read()).processing.items.length, 3);
  } finally { await handle.database.close(); }
});

test("explicit import writes a verified database, keeps the source untouched and coexists with legacy json", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-import");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceFile = join(directory, "news.json");
  const databaseFile = join(directory, "news.sqlite");
  const sourceText = JSON.stringify(legacyDocument(), null, 2) + "\n";
  await writeFile(sourceFile, sourceText, { mode: 0o600 });

  const report = await importLegacyNewsJson({ sourceFile, databaseFile });
  assert.deepEqual(report.counts, {
    sources: 1,
    articles: 3,
    runs: 2,
    runItems: 3,
    decisions: 2,
    feedback: 2,
    comments: 1,
    publications: 2,
  });
  assert.equal(await readFile(sourceFile, "utf8"), sourceText, "source must stay read-only");
  const handle = await openNewsRepository({ databaseFile, legacyJsonFile: sourceFile });
  t.after(() => handle.database.close());
  const state = await handle.repository.read();
  assert.deepEqual(state, parseNewsState(JSON.parse(sourceText)));
  // 被删源的文章与反馈仍在，取消反馈(null)语义保留，run 顺序按原文档顺序。
  assert.deepEqual(state.processing.items.map((item) => item.id), ["info_kept_1", "info_gone_1", "info_pending_1"]);
  assert.equal(state.processing.articleFeedback[0]!.reaction, null);
  assert.deepEqual(state.processing.runs.map((run) => run.id), ["inforun_1", "inforun_2"]);
});

test("import refuses to overwrite an existing target", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-import-exists");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceFile = join(directory, "news.json");
  const databaseFile = join(directory, "news.sqlite");
  await writeFile(sourceFile, JSON.stringify(legacyDocument()), { mode: 0o600 });
  await writeFile(databaseFile, "existing bytes", { mode: 0o600 });
  await assert.rejects(importLegacyNewsJson({ sourceFile, databaseFile }), /refusing to overwrite/);
  assert.equal(await readFile(databaseFile, "utf8"), "existing bytes");
});

test("import failures leave no target behind and report invalid documents accurately", async (t) => {
  const directory = await tempDirectory("pi-muse-news-sqlite-import-fail");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceFile = join(directory, "news.json");
  const databaseFile = join(directory, "news.sqlite");

  await writeFile(sourceFile, "{invalid", { mode: 0o600 });
  await assert.rejects(importLegacyNewsJson({ sourceFile, databaseFile }), /Invalid news document/);
  await assert.rejects(stat(databaseFile), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

  const duplicate = legacyDocument();
  duplicate.processing.items.push({ ...article("info_dup"), id: "info_kept_1" });
  await writeFile(sourceFile, JSON.stringify(duplicate), { mode: 0o600 });
  await assert.rejects(importLegacyNewsJson({ sourceFile, databaseFile }), /Invalid news document/);
  for (const leftover of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
    await assert.rejects(stat(leftover), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", leftover);
  }
});
