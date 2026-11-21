import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createService } from "../support/test-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { databaseTool } from "../../src/adapters/pi/tools/database.js";
import { createTools } from "../../src/adapters/pi/tools/index.js";
import { newsArticleDetailResponseSchema } from "../../src/http/contracts/news.js";

const start = async (t: TestContext) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-database-integration-"));
  const service = await createService(createConfig({
    server: { host: "127.0.0.1", accessKey: "database-integration-access" },
    runtime: { dataDir, schedulerIntervalMs: 3_600_000, monitorScanIntervalMs: 3_600_000 },
    tools: { browser: { enabled: false }, web: { enabled: false } },
  }));
  t.after(async () => { try { await service.close(); } finally { await rm(dataDir, { recursive: true, force: true }); } });
  const response = await service.app.request("/api/session", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessKey: "database-integration-access" }),
  });
  assert.equal(response.status, 200);
  const { token } = await response.json() as { token: string };
  return { service, headers: { authorization: `Bearer ${token}` } };
};

test("database registration and SQL writes share the news repository and HTTP facts without approvals", async (t) => {
  const { service, headers } = await start(t);
  const tools = createTools({
    root: service.layout.workspaceDir, memory: service.memory, jobs: service.jobs, database: service.database,
  });
  const tool = tools.find((entry) => entry.name === "database");
  assert.ok(tool, "actual injected service must register the tool");
  const beforeApprovals = await service.actions.list();
  const timestamp = new Date().toISOString();
  await service.newsRepository.update((state) => ({
    state: {
      ...state,
      sources: [{ id: "newssource_database", title: "Fixture", url: "https://example.com/feed", createdAt: timestamp, lastFetchedAt: null, lastError: null }],
      processing: {
        ...state.processing,
        items: [{ id: "info_database", source: "newssource_database", externalId: "one", title: "SQL feedback", content: "Synthetic article", receivedAt: timestamp, acceptedAt: timestamp, status: "processed", metadata: { sourceId: "newssource_database", sourceTitle: "Fixture", url: "https://example.com/article" } }],
      },
    },
    result: undefined,
  }));
  const result = await tool.execute("sql-feedback", {
    action: "execute", database: "news", statements: [
      { sql: "INSERT INTO news_article_feedback (item_id, position, reaction, saved) VALUES (?, 0, 'like', 1)", params: ["info_database"] },
      { sql: "INSERT INTO news_article_comments (id, item_id, position, text, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)", params: ["comment_database", "info_database", "SQL-created comment", timestamp, timestamp] },
      { sql: "ALTER TABLE news_sources ADD COLUMN agent_note TEXT" },
      { sql: "UPDATE news_sources SET agent_note = 'keep-extension' WHERE id = ?", params: ["newssource_database"] },
    ],
  }, undefined, undefined, {} as never);
  assert.notEqual(result.isError, true);
  const response = await service.app.request("/api/news/articles/info_database", { headers });
  assert.equal(response.status, 200);
  const { article } = newsArticleDetailResponseSchema.parse(await response.json());
  assert.equal(article.feedback.reaction, "like");
  assert.equal(article.feedback.saved, true);
  assert.equal(article.feedback.comments[0]?.text, "SQL-created comment");
  assert.deepEqual(await service.actions.list(), beforeApprovals);

  await service.newsRepository.update((state) => ({
    state: { ...state, sources: state.sources.map((source) => ({ ...source, lastFetchedAt: timestamp })) },
    result: undefined,
  }));
  const read = await service.database.execute({ action: "execute", database: "news", sql: "SELECT agent_note FROM news_sources WHERE id = ?", params: ["newssource_database"] });
  assert.ok("results" in read);
  assert.equal(read.results[0]?.rows[0]?.[0], "keep-extension", "service updates must preserve agent-added columns");
  assert.equal((await service.newsRepository.read()).processing.articleFeedback[0]?.reaction, "like");
});

test("database accesses main database and service close rejects late SQL", async (t) => {
  const { service } = await start(t);
  assert.ok((await stat(service.layout.mainDatabaseFile)).isFile());
  const tool = databaseTool(service.database);
  const written = await tool.execute("main-schema", {
    action: "execute", statements: [{ sql: "CREATE TABLE main_probe (id TEXT PRIMARY KEY)" }, { sql: "INSERT INTO main_probe VALUES (?)", params: ["one"] }],
  }, undefined, undefined, {} as never);
  assert.notEqual(written.isError, true);
  assert.ok((await stat(service.layout.mainDatabaseFile)).isFile());
  const [first, second] = await Promise.all([
    service.database.execute({ action: "execute", sql: "SELECT id FROM main_probe" }),
    service.database.execute({ action: "schema" }),
  ]);
  assert.ok("results" in first && "results" in second);
  assert.equal(first.results[0]?.rows[0]?.[0], "one");
  await service.close();
  const late = await tool.execute("late", { action: "execute", sql: "INSERT INTO main_probe VALUES ('late')" }, undefined, undefined, {} as never);
  assert.equal(late.isError, true);
  assert.equal(service.newsDatabase.database.isOpen, false);
});

test("a news database close error still closes main and marks the service closed", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-database-close-error-"));
  const service = await createService(createConfig({
    server: { host: "127.0.0.1" }, runtime: { dataDir, schedulerIntervalMs: 3_600_000, monitorScanIntervalMs: 3_600_000 },
    tools: { browser: { enabled: false }, web: { enabled: false } },
  }));
  await service.database.execute({ action: "execute", sql: "CREATE TABLE close_probe (id TEXT)" });
  const actualClose = service.newsDatabase.database.close.bind(service.newsDatabase.database);
  t.mock.method(service.newsDatabase.database, "close", () => {
    actualClose();
    throw new Error("synthetic news close failure");
  });
  try {
    await assert.rejects(service.close(), /synthetic news close failure/);
    assert.equal(service.lifecycle?.isClosing(), true);
    assert.equal(service.newsDatabase.database.isOpen, false);
    await assert.rejects(service.database.execute({ action: "execute", sql: "SELECT 1" }));
    await assert.rejects(stat(service.layout.mainDatabaseFile + "-wal"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await service.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
