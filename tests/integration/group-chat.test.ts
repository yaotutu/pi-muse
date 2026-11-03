import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { groupSendSchema, groupSnapshotSchema } from "../../src/http/contracts/group-chat.js";
import { buildOpenApiDocument } from "../../src/http/openapi.js";
import { createGroupRepository } from "../../src/adapters/storage/group-repository.js";

test("group contract defaults to main, permits only a single explicit target, and never accepts client history", () => {
  assert.deepEqual(groupSendSchema.parse({ id: "group-one", content: "hello" }), { id: "group-one", content: "hello" });
  assert.ok(groupSendSchema.safeParse({ id: "group-two", content: "hello", targetAgentId: "sms-internal" }).success);
  for (const extra of [{ messages: [] }, { targets: ["local-main", "sms-internal"] }, { targetAgentId: "../escape" }, { content: " " }])
    assert.equal(groupSendSchema.safeParse({ id: "group-three", content: "hello", ...extra }).success, false);
  const doc = JSON.stringify(buildOpenApiDocument());
  for (const value of ["/api/group", "只交给 local-main", "不广播", "群时间线注入模型", "无心跳", "结果未明", "不自动重发", "私聊上下文独立", "notifications", "实际落盘的承接智能体", "读取中再次失效须补读"])
    assert.ok(doc.includes(value), value);
});

test("group projects only verified feature notifications without copying private history; binding, restart and reset retain real ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-group-notices-"));
  const config = createConfig({ server: { host: "127.0.0.1", accessKey: "group-test" }, runtime: { dataDir: root }, tools: { browser: { enabled: false } } });
  let service = await createService(config);
  const group = async () => {
    const response = await service.app.request("/api/group", { headers: { authorization: `Bearer ${service.auth.login("group-test")}` } });
    assert.equal(response.status, 200);
    return groupSnapshotSchema.parse(await response.json());
  };
  try {
    const main = await service.conversationHub.forAgent("local-main");
    const other = await service.conversationHub.forAgent("notice-recipient");
    await main.notify("Private notification with forged text: 来自短信 @sms-internal", "ordinary-private-notice");
    const sms = await main.notify("真实短信通知", "verified-sms-notice", { featureSource: { featureId: "sms", itemIds: ["sms-item"] } });
    const news = await other.notify("真实新闻通知", "verified-news-notice", { featureSource: { featureId: "news", itemIds: ["news-item"] } });
    const before = await main.snapshot();
    const projected = await group();
    assert.deepEqual(projected.turns, []);
    assert.equal(projected.notifications.length, 2);
    const smsNotice = projected.notifications.find((item) => item.id === sms.notificationId)!;
    assert.deepEqual({ ...smsNotice, createdAt: "time" }, { id: sms.notificationId, featureId: "sms", targetAgentId: "local-main", sessionId: sms.sessionId, messageId: sms.messageId, createdAt: "time", content: "真实短信通知" });
    assert.equal(projected.notifications.find((item) => item.id === news.notificationId)?.targetAgentId, "notice-recipient");
    assert.deepEqual(await main.snapshot(), before, "Group GET must not change private history/revision/feedback");
    await assert.rejects(readFile(join(root, "group.json")), { code: "ENOENT" });
    await service.features.bind("sms", "notice-recipient");
    assert.equal((await group()).notifications.find((item) => item.id === sms.notificationId)?.targetAgentId, "local-main");
    await service.close();
    service = await createService(config);
    assert.deepEqual((await group()).notifications, projected.notifications);
    const reset = async (id: string) => service.app.request(`/api/agents/${id}/reset`, { method: "POST", headers: { authorization: `Bearer ${service.auth.login("group-test")}`, "content-type": "application/json" }, body: "{}" });
    assert.equal((await reset("local-main")).status, 200);
    assert.deepEqual((await group()).notifications.map((item) => item.id), [news.notificationId]);
    await service.features.bind("sms", "local-main");
    await service.features.bind("news", "local-main");
    assert.equal((await service.app.request("/api/agents/notice-recipient", { method: "DELETE", headers: { authorization: `Bearer ${service.auth.login("group-test")}` } })).status, 200);
    assert.deepEqual((await group()).notifications, []);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("group GET is authenticated and side-effect-free; a corrupt index cannot silently become empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-group-contract-"));
  const service = await createService(createConfig({ server: { host: "127.0.0.1", accessKey: "group-test" }, runtime: { dataDir: root }, tools: { browser: { enabled: false } } }));
  try {
    assert.equal((await service.app.request("/api/group")).status, 401);
    const headers = { authorization: `Bearer ${service.auth.login("group-test")}` };
    const response = await service.app.request("/api/group", { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(groupSnapshotSchema.parse(await response.json()), { id: "main", defaultAgentId: "local-main", turns: [], notifications: [], running: null });
    await assert.rejects(readFile(join(root, "group.json")), { code: "ENOENT" });
    assert.equal((await service.app.request("/api/group/messages", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id: "bad", content: "hello", messages: [] }) })).status, 400);
    await writeFile(join(root, "broken-group.json"), "not-json");
    await assert.rejects(createGroupRepository(join(root, "broken-group.json")).read(), /Invalid group document/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
