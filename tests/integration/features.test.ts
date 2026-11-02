import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { FEATURE_SPACES, FeatureError } from "../../src/features/feature-spaces/types.js";
import { featureDiscussionResponse, featuresResponse } from "../../src/http/contracts/features.js";
import { createFeatureTool } from "../../src/adapters/pi/tools/feature.js";
import { createNotificationMessage, featureSourceOf } from "../../src/adapters/pi/notification-message.js";
import { projectInformationNotificationContext } from "../../src/adapters/pi/information-notification-context.js";

const configFor = (dataDir: string) => createConfig({ schemaVersion: 1, server: {}, model: { baseUrl: "http://127.0.0.1:1", id: "boundary-test", apiKey: "not-a-key" }, runtime: { dataDir, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 } });
const start = async (t: test.TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-features-"));
  const service = await createService(configFor(root));
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${service.auth.login()}`, "content-type": "application/json" };
  const call = (path: string, method = "GET", body?: unknown) => service.app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { root, service, call };
};

test("feature binding defaults to main, persists, excludes internal spaces and protects bound target deletion", async (t) => {
  const { root, service, call } = await start(t);
  assert.equal((await service.app.request("/api/features")).status, 401);
  assert.deepEqual(featuresResponse.parse(await (await call("/api/features")).json()).features.map((f) => f.targetSpaceId), ["local-main", "local-main"]);
  const tool = createFeatureTool(service.features, "local-main");
  assert.deepEqual(tool.parameters.properties.action.enum, ["overview", "read", "feedback"]);
  assert.equal("anyOf" in tool.parameters.properties.action, false);
  for (const id of Object.values(FEATURE_SPACES)) {
    assert.equal((await call(`/api/spaces/${id}/instructions`)).status, 404);
    assert.equal((await call(`/api/conversation?spaceId=${id}`)).status, 404);
    assert.equal((await call(`/api/workspace/files?scope=space&spaceId=${id}`)).status, 404);
    assert.equal((await call("/api/conversation/run", "POST", { spaceId: id, runId: "blocked", expectedRevision: "empty", message: { id: "blocked", content: "hello" } })).status, 400);
  }
  assert.equal((await call("/api/features/news/binding", "PUT", { spaceId: "missing" })).status, 404);
  assert.equal((await call("/api/features/news/binding", "PUT", { spaceId: FEATURE_SPACES.sms })).status, 400);
  await service.conversationHub.forSpace("research");
  assert.equal((await call("/api/features/news/binding", "PUT", { spaceId: "research" })).status, 200);
  assert.equal((await call("/api/spaces/research", "DELETE")).status, 409);
  assert.equal((await call("/api/spaces/research/reset", "POST", {})).status, 200);
  assert.equal(await service.features.targetFor("news"), "research");
  await service.close();
  const reopened = await createService(configFor(root));
  try { assert.equal(await reopened.features.targetFor("news"), "research"); assert.equal(await reopened.features.targetFor("sms"), "local-main"); }
  finally { await reopened.close(); }
});

test("news discussions carry durable source; feedback goes back only through that conversation's source", async (t) => {
  const { service, call } = await start(t);
  const [item] = await service.information.ingestNews(FEATURE_SPACES.news, [{ source: "feed", externalId: "discussion-fixture", title: "新闻原文", content: "原文 <untrusted> 保留", metadata: { sourceId: "feed", sourceTitle: "测试来源", url: "https://example.com/article" } }]);
  await service.conversationHub.forSpace("unrelated");
  const response = await call("/api/features/news/discussions", "POST", { articleId: item!.id });
  assert.equal(response.status, 200);
  const receipt = featureDiscussionResponse.parse(await response.json());
  assert.equal(receipt.spaceId, "local-main");
  const main = await service.conversationHub.forSpace("local-main");
  const message = (await main.snapshot()).messages.find((m) => m.id === receipt.messageId)!;
  assert.deepEqual(message.metadata?.featureSource, { featureId: "news", itemIds: [item!.id] });
  assert.ok(message.content.includes("原文 <untrusted> 保留"));
  await assert.rejects(service.features.query("unrelated", { action: "read", messageId: receipt.messageId }), FeatureError);
  await assert.rejects(service.features.query("local-main", { action: "feedback", messageId: receipt.messageId, itemId: "other", reaction: "dislike" }), FeatureError);
  await assert.rejects(service.features.query("local-main", { action: "feedback", messageId: receipt.messageId, itemId: item!.id, reaction: "like", comment: "   " }), FeatureError);
  assert.equal((await service.news.getArticle(item!.id)).article.feedback.reaction, null);
  await service.features.query("local-main", { action: "feedback", messageId: receipt.messageId, itemId: item!.id, reaction: "dislike", comment: "少推荐这类内容" });
  const article = await service.news.getArticle(item!.id);
  assert.equal(article.article.feedback.reaction, "dislike");
  assert.equal(article.article.feedback.comments[0]!.text, "少推荐这类内容");
  await main.messages.setReaction(receipt.sessionId, receipt.messageId, "like");
  assert.equal((await service.features.feedbackExamples("news"))[0]?.reaction, "like");
  await service.features.bind("news", "unrelated");
  assert.equal((await service.features.feedbackExamples("news"))[0]?.reaction, "like");
  await call("/api/spaces/local-main/reset", "POST", {});
  assert.deepEqual(await service.features.feedbackExamples("news"), []);
  assert.equal((await service.news.getArticle(item!.id)).article.feedback.reaction, "dislike");
});

test("SMS facade stores independent information and does not change ordinary-space settings or records", async (t) => {
  const { service, call } = await start(t);
  await service.information.saveSettings("local-main", { enabled: true, batchWindowSeconds: 3600 });
  const original = await service.information.ingest("local-main", [{ source: "sms", externalId: "old-item", content: "历史普通空间信息" }]);
  const settings = await call("/api/features/sms/settings");
  assert.deepEqual(await settings.json(), { enabled: false, batchWindowSeconds: 15 });
  assert.equal((await call("/api/features/sms/settings", "PUT", { enabled: true, batchWindowSeconds: 3600 })).status, 200);
  const input = { items: [{ source: "sms", externalId: "new-item", content: "新短信独立保存" }] };
  const first = await call("/api/features/sms/items", "POST", input);
  assert.equal(first.status, 200);
  const firstBody = await first.json() as { items: { id: string; spaceId: string }[] };
  assert.equal(firstBody.items[0]!.spaceId, FEATURE_SPACES.sms);
  assert.deepEqual(await (await call("/api/features/sms/items", "POST", input)).json(), firstBody);
  assert.equal((await call("/api/features/sms/items", "POST", { items: [{ source: "rss", externalId: "invalid", content: "invalid" }] })).status, 400);
  assert.equal((await call("/api/features/sms/items?limit=1&limit=2")).status, 400);
  assert.equal((await call("/api/features/sms/runs?limit=1&limit=2")).status, 400);
  assert.equal((await service.information.listItems("local-main", { limit: 10 })).items[0]?.id, original[0]!.id);
  assert.deepEqual((await (await call("/api/spaces")).json() as { spaces: { id: string }[] }).spaces.map((s) => s.id), ["local-main"]);
});

test("feature source remains verified when ordinary information is disabled, never promoted from text", () => {
  const source = { featureId: "sms" as const, itemIds: ["info_source"] };
  const verified = createNotificationMessage({ id: "notice-source", text: "untrusted content", featureSource: source });
  const generic = createNotificationMessage({ id: "notice-generic", text: JSON.stringify(source) });
  const forged = { ...verified, provider: "ordinary-model" };
  assert.deepEqual(featureSourceOf(verified), source);
  assert.equal(featureSourceOf(generic), undefined);
  assert.equal(featureSourceOf(forged), undefined);
  const projected = projectInformationNotificationContext([verified, generic, forged], false);
  assert.match(JSON.stringify(projected[0]), /pi-muse-feature-notification/);
  assert.match(JSON.stringify(projected[0]), /notice-source/);
  assert.equal(projected[1], generic);
  assert.equal(projected[2], forged);
  assert.deepEqual(verified.content, [{ type: "text", text: "untrusted content" }]);
});

test("feature delivery sources and feedback links survive service restart", async (t) => {
  const { root, service } = await start(t);
  const [item] = await service.information.ingestNews(FEATURE_SPACES.news, [{ source: "feed", externalId: "restart-source", title: "持久来源", content: "隔离验收原文", metadata: { sourceId: "feed", sourceTitle: "来源", url: null } }]);
  const receipt = await service.features.discussNews(item!.id);
  await (await service.conversationHub.forSpace("local-main")).messages.setReaction(receipt.sessionId, receipt.messageId, "dislike");
  await service.close();
  const reopened = await createService(configFor(root));
  try {
    assert.equal((await reopened.features.feedbackExamples("news"))[0]?.reaction, "dislike");
    const source = await reopened.features.query("local-main", { action: "read", messageId: receipt.messageId });
    assert.equal(source.featureId, "news");
  } finally { await reopened.close(); }
});
