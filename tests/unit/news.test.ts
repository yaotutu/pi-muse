import { memoryInformationRules } from "../support/information-rules.js";
import { createSubmitInformationResultTool } from "../../src/adapters/pi/information-runner.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInformationRepository } from "../../src/adapters/storage/information-repository.js";
import { smsModule } from "../../src/adapters/storage/sms-schema.js";
import { ensureSqliteModules } from "../../src/adapters/storage/sqlite-modules.js";
import { openNewsRepository } from "../../src/adapters/storage/news-repository.js";
import { openSqliteDatabase, type ManagedSqliteDatabase } from "../../src/adapters/storage/sqlite-database.js";
import { createDataLayout, type DataLayout } from "../../src/adapters/storage/data-layout.js";
import { cleanRssText, fetchRss2, parseRss2 } from "../../src/adapters/news/rss.js";
import { NewsError, NewsSourceError, type NewsSourceFailure } from "../../src/features/news/errors.js";
import { createNewsRoutes } from "../../src/http/routes/news.js";
import {
  newsCreateSourceErrorSchema,
  newsCreateSourceResponseSchema,
  newsRefreshResponseSchema,
  newsSourceListResponseSchema,
} from "../../src/http/contracts/news.js";
import { createInformationService } from "../../src/features/information/service.js";
import type { InformationRepository } from "../../src/features/information/types.js";
import { createNewsService } from "../../src/features/news/service.js";

/** 短信事实存 main.sqlite 的 sms_* 表；测试内单独开库并与新闻库一起收尾。 */
const openInformationRepository = async (
  layout: DataLayout,
): Promise<{ managed: ManagedSqliteDatabase; repository: InformationRepository }> => {
  const managed = await openSqliteDatabase(layout.mainDatabaseFile);
  await managed.serialize(() => ensureSqliteModules(managed, [smsModule]));
  return { managed, repository: createInformationRepository(managed) };
};

const rss = (items: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example Feed</title>${items}</channel></rss>`;

const item = (guid: string, title: string, date: string, content = "Details") =>
  `<item><guid>${guid}</guid><title>${title}</title><link>https://example.com/${guid}</link>` +
  `<description><![CDATA[<p>${content}</p><script>bad()</script>]]></description>` +
  `<pubDate>${date}</pubDate></item>`;

test("RSS2 parser validates stable items and strips executable markup", () => {
  const parsed = parseRss2(rss(
    item("a", "A &amp; B", "Wed, 29 Oct 2026 10:00:00 GMT", "Hello <b>world</b>") +
    item("b", "Second", "Thu, 30 Oct 2026 10:00:00 GMT"),
  ));
  assert.equal(parsed.title, "Example Feed");
  assert.equal(parsed.items[0]?.externalId, "a");
  assert.equal(parsed.items[0]?.title, "A & B");
  assert.equal(parsed.items[0]?.content, "Hello world");
  assert.equal(parsed.items[0]?.url, "https://example.com/a");
  assert.equal(parsed.items[0]?.publishedAt, "2026-10-29T10:00:00.000Z");
  assert.equal(cleanRssText("<style>x</style><p>safe</p>"), "safe");
  assert.equal(
    cleanRssText("&lt;script&gt;bad()&lt;/script&gt;&lt;p&gt;escaped safe&lt;/p&gt;"),
    "escaped safe",
  );
});

test("RSS2 parser rejects unsafe XML and feeds with more than half invalid items", () => {
  for (const xml of [
    `<!DOCTYPE rss [<!ENTITY x "y">]><rss><channel><title>x</title></channel></rss>`,
    "<rss><channel>",
    "<html><body>Not a feed</body></html>",
    rss("<item><title>No identity</title><description>body</description></item>"),
    rss("<item><guid>x</guid><title></title><description>body</description></item>"),
    rss(item("valid", "Valid", "") + "<item/><item/>"),
  ]) {
    assert.throws(() => parseRss2(xml), { message: "RSS source failed: PARSE_INVALID" });
  }
});

test("RSS2 parser skips bad items, accepts exactly half invalid and retains title-only articles", () => {
  const thin = "<item><guid>thin</guid><title>Title only</title></item>";
  const parsed = parseRss2(rss(
    thin + item("good", "Good", "", "x") +
    "<item><title>No ID</title></item>" + "<item><guid>no-title</guid></item>",
  ));
  assert.equal(parsed.skipped, 2);
  assert.deepEqual(parsed.items.map(({ externalId, content }) => ({ externalId, content })), [
    { externalId: "thin", content: "" }, { externalId: "good", content: "x" },
  ]);
  assert.equal(parseRss2(rss("<item/>" + thin)).skipped, 1);
  assert.equal(parseRss2(rss("")).skipped, 0);
  assert.equal(
    parseRss2(rss("<item><link>https://example.com/link</link><title>Link ID</title></item>")).items[0]?.externalId,
    "https://example.com/link",
  );
});

test("RSS2 parser enforces its nesting limit before traversing the parsed tree", () => {
  const nested = `${"<nested>".repeat(65)}value${"</nested>".repeat(65)}`;
  assert.throws(() => parseRss2(rss(
    "<item><guid>deep</guid><title>Deep</title><link>https://example.com/deep</link>" +
    `<description>${nested}</description><pubDate>Wed, 29 Oct 2026 10:00:00 GMT</pubDate></item>`,
  )), { message: /PARSE_INVALID/ });
});

test("recommendation processing projects decisions without retaining or notifying chat", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-service-"));
  const layout = createDataLayout(dataDir);
  const informationStorage = await openInformationRepository(layout);
  const informationRepository = informationStorage.repository;
  const newsStorage = await openNewsRepository({ databaseFile: layout.newsDatabaseFile });
  t.after(async () => {
    await newsStorage.database.close();
    await informationStorage.managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const newsRepository = newsStorage.repository;
  let retained = false;
  let failNext = false;
  let modelInput: Parameters<Parameters<typeof createInformationService>[0]["runModel"]>[0] | undefined;
  const information = createInformationService({
    rules: memoryInformationRules(),
    repository: informationRepository,

    retainMain: async () => {
      retained = true;
      return undefined;
    },
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async (input) => {
      modelInput = input;
      if (failNext) return { ok: false, error: "MODEL_REQUEST_FAILED" };
      return {
        ok: true,
        result: {
          decisions: input.items.map((article, index) => ({
            itemId: article.id,
            decision: index === 0 ? "notify" as const : "silent" as const,
            reason: index === 0 ? "substantive release" : "routine",
          })),
          notifications: [],
          learnedNotes: "Values substantive releases.",
        },
      };
    },
  });
  let feed = rss(
    item("old", "Older", "Wed, 29 Oct 2026 10:00:00 GMT") +
    item("new", "Newer", "Thu, 30 Oct 2026 10:00:00 GMT"),
  );
  const news = createNewsService({
    repository: newsRepository,
    information,
      fetchFeed: async () => parseRss2(feed),
  });
  await news.initialize();
  await news.savePreferences("Prefer primary sources and substantive engineering detail.");
  const { source } = await news.addSource({ url: "https://example.com/feed.xml" });
  assert.equal(source.title, "Example Feed");
  assert.equal((await news.refresh()).added, 2);
  feed = rss(
    item("old", "Older changed", "Wed, 29 Oct 2026 10:00:00 GMT", "Changed content") +
    item("new", "Newer changed", "Thu, 30 Oct 2026 10:00:00 GMT", "Changed content"),
  );
  assert.equal((await news.refresh()).added, 0, "duplicate GUIDs are accepted only once");

  const all = await news.listArticles({ view: "all", savedOnly: false, limit: 20 });
  assert.deepEqual(all.articles.map((article) => article.title), ["Newer", "Older"]);
  assert.ok(all.articles.every((article) => article.content === "Details"));
  await information.runNow();
  assert.equal(retained, false, "recommendation mode must not retain or notify a chat");
  assert.deepEqual(modelInput?.articleFeedback, []);
  assert.equal(modelInput?.preferences.notes, "Prefer primary sources and substantive engineering detail.");

  const recommended = await news.listArticles({ view: "recommended", savedOnly: false, limit: 20 });
  assert.equal(recommended.articles.length, 1);
  assert.equal(recommended.articles[0]?.recommendation?.reason, "substantive release");
  assert.deepEqual(await news.preferences(), {
    notes: "Prefer primary sources and substantive engineering detail.",
    learnedNotes: "Values substantive releases.",
  });

  const older = all.articles.find((article) => article.title === "Older")!;
  await news.setReaction(older.id, "like");
  await news.setReaction(older.id, "dislike");
  assert.equal((await news.getArticle(older.id)).article.feedback.reaction, "dislike");
  await news.setReaction(older.id, "like");
  await news.setSaved(older.id, true);
  await assert.rejects(news.addComment(older.id, "   "), /non-blank/);
  await assert.rejects(news.addComment(older.id, "x".repeat(4001)), /4000/);
  await news.addComment(older.id, "  useful context  ");
  const learnedBeforeFailure = await news.preferences();
  failNext = true;
  await information.ingestNews([{
    source: "newssource_test",
    externalId: "after-success",
    title: "Failure must not overwrite preferences",
    content: "Content",
    metadata: { sourceId: "newssource_test", sourceTitle: "Feed", url: null },
  }]);
  await information.runNow();
  assert.deepEqual(await news.preferences(), learnedBeforeFailure);
  await news.deleteSource(source.id);
  const retainedArticle = await news.getArticle(older.id);
  assert.equal(retainedArticle.article.feedback.reaction, "like");
  assert.equal(retainedArticle.article.feedback.saved, true);
  assert.equal(retainedArticle.article.feedback.comments[0]?.text, "useful context");
});

test("touching an old article makes its feedback recent for the next model input", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-feedback-"));
  const layout = createDataLayout(dataDir);
  const informationStorage = await openInformationRepository(layout);
  t.after(async () => {
    await informationStorage.managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const repository = informationStorage.repository;
  let captured: Parameters<Parameters<typeof createInformationService>[0]["runModel"]>[0] | undefined;
  const information = createInformationService({
    rules: memoryInformationRules(),
    repository,

    retainMain: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async (input) => {
      captured = input;
      return {
        ok: true,
        result: {
          decisions: input.items.map((article) => ({
            itemId: article.id,
            decision: "silent" as const,
            reason: "not selected",
          })),
          notifications: [],
          learnedNotes: "",
        },
      };
    },
  });
  try {
    await information.configure({
      enabled: true, batchWindowSeconds: 0, mode: "recommendations",
    });
    const inserted = await information.ingestNews(Array.from({ length: 22 }, (_, index) => ({
      source: "newssource_test",
      externalId: `guid-${index}`,
      title: `Article ${index}`,
      content: `Content ${index}`,
      metadata: { sourceId: "newssource_test", sourceTitle: "Feed", url: null },
    })));
    for (const article of inserted.slice(0, 21)) {
      await information.setArticleReaction(article.id, "like");
    }
    await information.setArticleReaction(inserted[0]!.id, "dislike");
    await information.runNow();
    assert.equal(captured?.articleFeedback[0]?.id, inserted[0]!.id);
    assert.equal(captured?.articleFeedback[0]?.reaction, "dislike");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("news pagination returns null nextCursor for an exact full page", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-pagination-"));
  const layout = createDataLayout(dataDir);
  const newsStorage = await openNewsRepository({ databaseFile: layout.newsDatabaseFile });
  const informationStorage = await openInformationRepository(layout);
  t.after(async () => {
    await newsStorage.database.close();
    await informationStorage.managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const information = createInformationService({
    rules: memoryInformationRules(),
    repository: informationStorage.repository,

    retainMain: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  const news = createNewsService({
    repository: newsStorage.repository,
    information,
      fetchFeed: async () => {
      throw new Error("not used");
    },
  });
  await news.initialize();
  await information.ingestNews(Array.from({ length: 20 }, (_, index) => ({
    source: "newssource_test",
    externalId: `guid-${index}`,
    title: `Article ${index}`,
    content: `Content ${index}`,
    metadata: { sourceId: "newssource_test", sourceTitle: "Feed", url: null },
  })));

  const full = await news.listArticles({ view: "all", savedOnly: false, limit: 20 });
  assert.equal(full.articles.length, 20);
  assert.equal(full.nextCursor, null);

  const first = await news.listArticles({ view: "all", savedOnly: false, limit: 19 });
  assert.equal(first.articles.length, 19);
  assert.ok(first.nextCursor);
  const second = await news.listArticles({
    view: "all",
    savedOnly: false,
    limit: 19,
    cursor: first.nextCursor,
  });
  assert.equal(second.articles.length, 1);
  assert.equal(second.nextCursor, null);
});

test("background refresh keeps failed articles failed while explicit refresh requeues them", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-retry-"));
  const layout = createDataLayout(dataDir);
  const newsStorage = await openNewsRepository({ databaseFile: layout.newsDatabaseFile });
  const informationStorage = await openInformationRepository(layout);
  t.after(async () => {
    await newsStorage.database.close();
    await informationStorage.managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const information = createInformationService({
    rules: memoryInformationRules(),
    repository: informationStorage.repository,

    retainMain: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  const feed = parseRss2(rss(item("retry", "Retry", "Wed, 29 Oct 2026 10:00:00 GMT")));
  const news = createNewsService({
    repository: newsStorage.repository,
    information,
      fetchFeed: async () => feed,
  });
  await news.initialize();
  await news.addSource({ url: "https://example.com/feed.xml" });
  await news.refresh({ retryFailed: true });
  await information.runNow();
  assert.deepEqual(await information.getNewsCounts(), {
    processing: false,
    pendingCount: 0,
    failedCount: 1,
  });

  await news.refresh({ retryFailed: false });
  assert.deepEqual(await information.getNewsCounts(), {
    processing: false,
    pendingCount: 0,
    failedCount: 1,
  });
  await news.refresh({ retryFailed: true });
  assert.deepEqual(await information.getNewsCounts(), {
    processing: false,
    pendingCount: 1,
    failedCount: 0,
  });
});

test("concurrent news refresh is rejected without queueing", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-refresh-"));
  const layout = createDataLayout(dataDir);
  const newsStorage = await openNewsRepository({ databaseFile: layout.newsDatabaseFile });
  const informationStorage = await openInformationRepository(layout);
  t.after(async () => {
    await newsStorage.database.close();
    await informationStorage.managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const information = createInformationService({
    rules: memoryInformationRules(),
    repository: informationStorage.repository,

    retainMain: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  const feed = parseRss2(rss(item("concurrent", "Concurrent", "Wed, 29 Oct 2026 10:00:00 GMT")));
  let calls = 0;
  let releaseRefresh!: () => void;
  let markRefreshStarted!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
  const news = createNewsService({
    repository: newsStorage.repository,
    information,
      fetchFeed: async () => {
      calls++;
      if (calls === 1) return feed;
      markRefreshStarted();
      await refreshGate;
      return feed;
    },
  });
  await news.initialize();
  await news.addSource({ url: "https://example.com/feed.xml" });

  const active = news.refresh({ retryFailed: true });
  await refreshStarted;
  await assert.rejects(news.refresh({ retryFailed: true }), /already running/);
  releaseRefresh();
  await active;
});

test("one broken RSS source does not block another and its error stays controlled", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-news-source-error-"));
  const layout = createDataLayout(dataDir);
  const newsStorage = await openNewsRepository({ databaseFile: layout.newsDatabaseFile });
  const informationStorage = await openInformationRepository(layout);
  t.after(async () => {
    await newsStorage.database.close();
    await informationStorage.managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const information = createInformationService({
    rules: memoryInformationRules(),
    repository: informationStorage.repository,

    retainMain: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel: async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
  });
  const goodFeed = parseRss2(rss(item("good", "Good", "Wed, 29 Oct 2026 10:00:00 GMT")));
  const badFeed = parseRss2(rss(item("bad", "Bad", "Thu, 30 Oct 2026 10:00:00 GMT")));
  let failBad = false;
  const news = createNewsService({
    repository: newsStorage.repository,
    information,
      fetchFeed: async (url) => {
      if (url.includes("bad") && failBad) throw new Error("upstream-marker-4wrqxe7u");
      return url.includes("bad") ? badFeed : goodFeed;
    },
  });
  await news.initialize();
  const good = await news.addSource({ url: "https://example.com/good.xml" });
  await news.addSource({ url: "https://example.com/bad.xml" });
  failBad = true;

  assert.equal((await news.refresh({ retryFailed: true })).added, 1);
  const all = await news.listArticles({ view: "all", savedOnly: false, limit: 20 });
  assert.deepEqual(all.articles.map((article) => article.title), ["Good"]);
  const sources = (await news.listSources()).sources;
  assert.equal(sources.find((source) => source.id === good.source.id)?.lastError, null);
  assert.equal(
    sources.find((source) => source.url.includes("bad"))?.lastError,
    "RSS source failed: UNKNOWN",
  );
  assert.ok(!JSON.stringify(sources).includes("upstream-marker-4wrqxe7u"));
});

test("recommendation tool schema omits notifications, permits empty learned notes and rejects object notifications", async () => {
  const submissions: unknown[]=[];
  const tool=createSubmitInformationResultTool(["item"],(value)=>{submissions.push(value);},"recommendations");
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(),["decisions","learnedNotes"]);
  assert.deepEqual([...tool.parameters.required!].sort(),["decisions","learnedNotes"]);
  assert.equal(tool.parameters.additionalProperties,false);
  const invoke=(input:unknown)=>tool.execute("news",input as never,undefined,undefined,{} as never);
  const valid={decisions:[{itemId:"item",decision:"notify",reason:"useful"}],learnedNotes:""};
  const accepted=await invoke(valid);
  assert.equal(accepted.isError,undefined);
  assert.deepEqual(submissions,[{...valid,notifications:[]}]);
  for(const input of [{...valid,notifications:{}},{...valid,notifications:[]},{...valid,decisions:[]},{...valid,learnedNotes:undefined}]) {
    assert.equal((await invoke(input)).isError,true);
  }
  assert.equal(submissions.length,1,"invalid model input must never be normalized into a valid submission");
  const sms=createSubmitInformationResultTool(["item"],()=>assert.fail("object is not an array"));
  assert.equal(sms.parameters.properties.notifications?.type,"array");
  assert.ok(sms.parameters.required?.includes("notifications"));
  assert.equal((await sms.execute("sms",{...valid,notifications:{}} as never,undefined,undefined,{} as never)).isError,true);
});

/** SQLite 新闻/信息仓储与新闻路由的最小装配；每个用例使用独立临时目录。 */
const rssFixture = async (
  t: test.TestContext,
  fetchFeed: Parameters<typeof createNewsService>[0]["fetchFeed"],
  runModel: Parameters<typeof createInformationService>[0]["runModel"] =
    async () => ({ ok: false, error: "MODEL_REQUEST_FAILED" }),
) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-rss-boundaries-"));
  const layout = createDataLayout(dataDir);
  const informationStorage = await openInformationRepository(layout);
  const newsStorage = await openNewsRepository({
    databaseFile: layout.newsDatabaseFile,
  });
  const information = createInformationService({
    rules: memoryInformationRules(),
    repository: informationStorage.repository,
    retainMain: async () => undefined,
    feedback: { read: async () => ({ schemaVersion: 1, events: [] }) } as never,
    runModel,
  });
  const news = createNewsService({ repository: newsStorage.repository, information, fetchFeed });
  t.after(async () => {
    await news.close();
    await information.close();
    await newsStorage.database.close();
    await informationStorage.managed.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await news.initialize();
  return { news, repository: newsStorage.repository, information, app: createNewsRoutes({ news }) };
};

test("RSS transport failures are classified without leaking upstream content, causes or stacks", async () => {
  const sensitive = "upstream-private-marker";
  const cases: [unknown, NewsSourceFailure][] = [
    [Object.assign(new Error(sensitive), { code: "ENOTFOUND" }), { category: "NETWORK" }],
    [Object.assign(new Error(sensitive), { code: "ECONNRESET" }), { category: "NETWORK" }],
    [new Error("DNS unavailable"), { category: "NETWORK" }],
    [new Error("Blocked private address"), { category: "SSRF_BLOCKED" }],
    [new Error("Blocked local hostname"), { category: "SSRF_BLOCKED" }],
    [Object.assign(new Error(sensitive), { name: "AbortError" }), { category: "TIMEOUT" }],
    [Object.assign(new Error(sensitive), { code: "ETIMEDOUT" }), { category: "TIMEOUT" }],
    [new Error("HTTP 403"), { category: "HTTP_ERROR", httpStatus: 403 }],
    [new Error(sensitive, { cause: new Error("private-stack") }), { category: "UNKNOWN" }],
    [sensitive, { category: "UNKNOWN" }],
  ];
  for (const [error, failure] of cases) {
    await assert.rejects(fetchRss2("https://example.com/rss", { timeoutMs: 10, maxResponseBytes: 1024 },
      new AbortController().signal, async () => { throw error; }), (actual: unknown) => {
      assert.ok(actual instanceof NewsSourceError);
      assert.deepEqual(actual.failure, failure);
      assert.ok(!actual.message.includes(sensitive));
      assert.equal(actual.cause, undefined);
      return true;
    });
  }
  for (const status of [300, 304, 403, 503]) {
    await assert.rejects(fetchRss2("https://example.com/rss", { timeoutMs: 10, maxResponseBytes: 1024 },
      new AbortController().signal, async () => ({
        status, contentType: "text/xml", body: sensitive, finalUrl: `https://redirect.example/${sensitive}`,
      })),
    (error: unknown) => error instanceof NewsSourceError && error.failure.category === "HTTP_ERROR" &&
      error.failure.httpStatus === status && !error.message.includes(sensitive));
  }
  await assert.rejects(fetchRss2("https://example.com/rss", { timeoutMs: 10, maxResponseBytes: 1024 },
    new AbortController().signal, async () => ({
      status: 200, contentType: "text/html", body: `<html>${sensitive}</html>`, finalUrl: "https://example.com",
    })),
  { message: "RSS source failed: PARSE_INVALID" });
});

test("add-source 400 and persisted source errors share classifications and discard arbitrary NewsError messages", async (t) => {
  let failure: unknown;
  const feed = parseRss2(rss(item("ok", "OK", "")));
  const { app, repository } = await rssFixture(t, async () => {
    if (failure) throw failure;
    return feed;
  });
  const postSource = () => app.request("/sources", {
    method: "POST", body: JSON.stringify({ url: "https://example.com/feed" }),
  });
  for (const details of [
    { category: "NETWORK" }, { category: "SSRF_BLOCKED" }, { category: "TIMEOUT" },
    { category: "HTTP_ERROR", httpStatus: 403 }, { category: "PARSE_INVALID" }, { category: "UNKNOWN" },
  ] satisfies NewsSourceFailure[]) {
    failure = new NewsSourceError(details);
    const response = await postSource();
    assert.equal(response.status, 400);
    assert.deepEqual(newsCreateSourceErrorSchema.parse(await response.json()).failure, details);
    assert.equal((await repository.read()).sources.length, 0);
  }
  failure = undefined;
  assert.equal((await postSource()).status, 200);
  failure = new NewsSourceError({ category: "HTTP_ERROR", httpStatus: 503 });
  const refresh = await app.request("/refresh", { method: "POST", body: "{}" });
  assert.equal(refresh.status, 200, "all source failures remain a successful collection attempt");
  newsRefreshResponseSchema.parse(await refresh.json());
  const sources = newsSourceListResponseSchema.parse(await (await app.request("/sources")).json());
  assert.deepEqual(sources.sources[0]?.lastErrorDetails, { category: "HTTP_ERROR", httpStatus: 503 });
  assert.deepEqual(
    (await repository.read()).sources[0]?.lastErrorDetails,
    sources.sources[0]?.lastErrorDetails,
  );
  failure = new NewsError("INVALID_INPUT", "external-content-private-marker");
  await app.request("/refresh", { method: "POST", body: "{}" });
  assert.deepEqual((await repository.read()).sources[0]?.lastErrorDetails, { category: "UNKNOWN" });
  assert.ok(!JSON.stringify(await repository.read()).includes("external-content-private-marker"));
  failure = undefined;
  await app.request("/refresh", { method: "POST", body: "{}" });
  assert.equal((await repository.read()).sources[0]?.lastErrorDetails, null);
  assert.equal((await repository.read()).sources[0]?.lastError, null);
});

test("RSS skipped counts reach add/refresh responses and empty body items survive ingestion", async (t) => {
  let xml = rss("<item/>" + "<item><guid>thin</guid><title>Thin</title></item>");
  const { app, news, repository } = await rssFixture(t, async () => parseRss2(xml));
  const created = await app.request("/sources", {
    method: "POST", body: JSON.stringify({ url: "https://example.com/rss" }),
  });
  assert.equal(newsCreateSourceResponseSchema.parse(await created.json()).skipped, 1);
  assert.equal((await news.listArticles({ view: "all", savedOnly: false, limit: 20 })).articles.length, 0);
  assert.deepEqual(
    newsRefreshResponseSchema.parse(await (await app.request("/refresh", { method: "POST", body: "{}" })).json()),
    { added: 1, skipped: 1, resetDeferred: false },
  );
  assert.equal((await news.listArticles({ view: "all", savedOnly: false, limit: 20 })).articles[0]?.content, "Thin");
  xml = rss("<item/><item/>" + item("not-ingested", "Rejected feed", ""));
  assert.equal((await news.refresh()).added, 0);
  assert.deepEqual((await repository.read()).sources[0]?.lastErrorDetails, { category: "PARSE_INVALID" });
});

test("RSS URL normalization deduplicates aliases, legacy fragments and concurrent additions", async (t) => {
  let fetches = 0;
  const { news, repository } = await rssFixture(t, async () => {
    fetches++;
    return parseRss2(rss(""));
  });
  const { source } = await news.addSource({ url: "HTTPS://EXAMPLE.COM:443/feed#first" });
  assert.equal(source.url, "https://example.com/feed");
  for (const url of ["https://example.com/feed", "https://EXAMPLE.COM:443/feed#second"]) {
    await assert.rejects(news.addSource({ url }), (error: unknown) =>
      error instanceof NewsError && error.code === "CONFLICT" && error.message.includes(source.id));
  }
  assert.equal(fetches, 1, "duplicates are rejected before fetching");
  await repository.update((state) => ({
    state: {
      ...state,
      sources: state.sources.map((candidate) => ({ ...candidate, url: `${candidate.url}#legacy` })),
    },
    result: undefined,
  }));
  await assert.rejects(news.addSource({ url: "https://example.com/feed#new" }), /already exists/);
  assert.equal(
    (await repository.read()).sources[0]?.url,
    "https://example.com/feed#legacy",
    "checking legacy URLs must not rewrite storage",
  );
  const results = await Promise.allSettled([
    news.addSource({ url: "HTTP://EXAMPLE.COM:80/other#one" }),
    news.addSource({ url: "http://example.com/other#two" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.match(rejected.reason.message, /already exists: newssource_/);
  assert.equal((await repository.read()).sources.length, 2);
});

test("manual refresh explicitly reports deferred reset during a model run without automatic retry", async (t) => {
  let release!: () => void;
  let started!: () => void;
  let gated = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });
  t.after(() => release());
  const { news, information, app } = await rssFixture(t, async () => parseRss2(rss("")), async () => {
    if (gated) { started(); await gate; }
    return { ok: false, error: "MODEL_REQUEST_FAILED" };
  });
  const ingest = (id: string) => information.ingestNews([{
    source: "newssource_test", externalId: id, title: id, content: id,
    metadata: { sourceId: "newssource_test", sourceTitle: "Feed", url: null },
  }]);
  await ingest("failed");
  await information.runNow();
  gated = true;
  await ingest("active");
  const active = information.runNow();
  await running;
  const result = await app.request("/refresh", { method: "POST", body: "{}" });
  assert.deepEqual(
    newsRefreshResponseSchema.parse(await result.json()),
    { added: 0, skipped: 0, resetDeferred: true },
  );
  assert.equal((await information.getNewsCounts()).failedCount, 1);
  assert.equal((await news.refresh({ retryFailed: false })).resetDeferred, false);
  release();
  await active;
  assert.deepEqual(await information.getNewsCounts(), {
    processing: false, pendingCount: 0, failedCount: 2,
  });
  assert.equal((await news.refresh({ retryFailed: true })).resetDeferred, false);
  assert.equal((await information.getNewsCounts()).pendingCount, 2);
});

test("news storage accepts optional failure details without migrating legacy sources and rejects invalid details", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-rss-storage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const databaseFile = join(dir, "news.sqlite");
  const first = await openNewsRepository({ databaseFile });
  await first.repository.update((state) => ({
    state: {
      ...state,
      sources: [{
        id: "newssource_legacy", title: "Legacy", url: "https://example.com/rss#legacy",
        createdAt: new Date().toISOString(), lastFetchedAt: null, lastError: "RSS source fetch or parse failed",
      }],
    },
    result: undefined,
  }));
  const before = await first.repository.read();
  await first.repository.validate();
  assert.equal(Object.hasOwn((await first.repository.read()).sources[0]!, "lastErrorDetails"), false);
  assert.deepEqual(await first.repository.read(), before);
  for (const details of [
    { category: "OTHER" }, { category: "HTTP_ERROR", httpStatus: 999 },
    { category: "UNKNOWN", body: "must-not-persist" },
  ]) {
    await assert.rejects(first.repository.update((state) => ({
      state: {
        ...state,
        sources: state.sources.map((source) => ({
          ...source, lastErrorDetails: details as NewsSourceFailure,
        })),
      },
      result: undefined,
    })), /Invalid news document/);
  }
  assert.deepEqual(await first.repository.read(), before, "invalid writes never change the old state");
  await first.repository.update((state) => ({
    state: {
      ...state,
      sources: state.sources.map((source) => ({
        ...source, lastErrorDetails: { category: "HTTP_ERROR" as const, httpStatus: 403 },
      })),
    },
    result: undefined,
  }));
  assert.deepEqual(
    (await first.repository.read()).sources[0]?.lastErrorDetails,
    { category: "HTTP_ERROR", httpStatus: 403 },
  );
  await first.database.close();
  const second = await openNewsRepository({ databaseFile });
  try {
    assert.deepEqual(
      (await second.repository.read()).sources[0]?.lastErrorDetails,
      { category: "HTTP_ERROR", httpStatus: 403 },
    );
  } finally {
    await second.database.close();
  }
});
