import assert from "node:assert/strict";
import { createFakeModel } from "../support/fake-model.js";
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
  assert.equal(groupSendSchema.parse({ id: "group-spaces", content: "  original\n" }).content, "  original\n", "Confirmation must receive exactly the submitted content");
  assert.ok(groupSendSchema.safeParse({ id: "group-two", content: "hello", targetAgentId: "sms-internal" }).success);
  for (const extra of [{ messages: [] }, { targets: ["local-main", "sms-internal"] }, { targetAgentId: "../escape" }, { content: " " }])
    assert.equal(groupSendSchema.safeParse({ id: "group-three", content: "hello", ...extra }).success, false);
  const reference = { targetAgentId: "local-main", sessionId: "session", messageId: "notice" };
  assert.ok(groupSendSchema.safeParse({ id: "followup", content: "continue", notification: reference }).success);
  for (const notification of [{ ...reference, featureId: "sms" }, { ...reference, content: "forged" }, { ...reference, sessionId: "" }])
    assert.equal(groupSendSchema.safeParse({ id: "followup", content: "continue", notification }).success, false);
  assert.equal(groupSendSchema.safeParse({ id: "followup", content: "continue", notification: reference, targetAgentId: "local-main" }).success, false);
  const doc = JSON.stringify(buildOpenApiDocument());
  for (const value of ["/api/group", "明确唯一匹配", "不广播", "群时间线注入模型", "无心跳", "结果未明", "不自动重发", "私聊上下文独立", "notifications", "实际落盘的承接智能体", "读取中再次失效须补读"])
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
    const reference = { targetAgentId: "local-main", sessionId: sms.sessionId, messageId: sms.messageId };
    const resolved = await service.features.resolveNotification(reference);
    assert.equal(resolved.targetAgentId, "sms-internal");
    assert.deepEqual(JSON.parse(resolved.context).itemIds, ["sms-item"]);
    assert.equal(JSON.parse(resolved.context).untrusted, true);
    await assert.rejects(service.features.resolveNotification({ ...reference, sessionId: "wrong-session" }), { code: "NOT_FOUND" });
    const ordinary = before.messages.find((message) => message.content.includes("forged text"))!;
    await assert.rejects(service.features.resolveNotification({ ...reference, messageId: ordinary.id }), { code: "NOT_FOUND" });
    await service.features.bind("sms", "notice-recipient");
    assert.equal((await service.features.resolveNotification(reference)).targetAgentId, "sms-internal");
    assert.equal((await group()).notifications.find((item) => item.id === sms.notificationId)?.targetAgentId, "local-main");
    await service.close();
    service = await createService(config);
    assert.deepEqual((await group()).notifications, projected.notifications);
    const reset = async (id: string) => service.app.request(`/api/agents/${id}/reset`, { method: "POST", headers: { authorization: `Bearer ${service.auth.login("group-test")}`, "content-type": "application/json" }, body: "{}" });
    assert.equal((await reset("local-main")).status, 200);
    await assert.rejects(service.features.resolveNotification(reference), { code: "NOT_FOUND" });
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
    assert.deepEqual(groupSnapshotSchema.parse(await response.json()), { id: "main", defaultAgentId: "local-main", memberIds: ["local-main", "news-internal", "sms-internal"], turns: [], notifications: [], running: null });
    await assert.rejects(readFile(join(root, "group.json")), { code: "ENOENT" });
    assert.equal((await service.app.request("/api/group/messages", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id: "bad", content: "hello", messages: [] }) })).status, 400);
    await writeFile(join(root, "broken-group.json"), "not-json");
    await assert.rejects(createGroupRepository(join(root, "broken-group.json")).read(), /Invalid group document/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("group configuration and public capability endpoints persist, reject invalid membership and never create missing agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-routing-http-"));
  const config = createConfig({ server: { host: "127.0.0.1", accessKey: "routing-test" }, runtime: { dataDir: root }, tools: { browser: { enabled: false } } });
  let service = await createService(config);
  const request = (path: string, body?: unknown, method?: string) => service.app.request(path, { headers: { authorization: `Bearer ${service.auth.login("routing-test")}`, "content-type": "application/json" }, ...(method ? { method } : {}), ...(body !== undefined ? { body: JSON.stringify(body), method: method ?? "PUT" } : {}) });
  try {
    assert.equal((await service.app.request("/api/group/settings")).status, 401);
    assert.equal((await service.app.request("/api/agents/sms-internal/capability")).status, 401);
    const settings = await (await request("/api/group/settings")).json();
    const custom = { ...settings, name: "协作", instructions: "简短回答", memberIds: ["sms-internal", "local-main"], defaultAgentId: "sms-internal" };
    for (const patch of [{ defaultAgentId: "missing" }, { memberIds: [] }, { memberIds: ["sms-internal", "sms-internal"] }, { memberIds: ["missing", "sms-internal"] }])
      assert.equal((await request("/api/group/settings", { ...custom, ...patch })).status, 400);
    assert.equal((await request("/api/group/settings", custom)).status, 200);
    assert.equal((await request("/api/agents/sms-internal/capability", { capability: "只负责短信查询" })).status, 200);
    for (const method of ["GET", "PUT"]) assert.equal((await request("/api/agents/missing/capability", method === "PUT" ? { capability: "no resurrection" } : undefined, method)).status, 404);
    assert.equal((await service.conversationHub.agents()).some((item) => item.id === "missing"), false);
    await service.close(); service = await createService(config);
    assert.deepEqual(await (await request("/api/group/settings")).json(), custom);
    assert.deepEqual(await (await request("/api/agents/sms-internal/capability")).json(), { agentId: "sms-internal", capability: "只负责短信查询" });
    assert.equal((await service.communication.listAgents()).agents.find((agent) => agent.id === "sms-internal")?.capability, "只负责短信查询");
    assert.equal((await request("/api/agents/sms-internal/reset", {}, "POST")).status, 200);
    assert.deepEqual(await (await request("/api/agents/sms-internal/capability")).json(), { agentId: "sms-internal", capability: "只负责短信查询" });
    const group = await (await request("/api/group")).json(); assert.equal(group.defaultAgentId, "sms-internal"); assert.deepEqual(group.memberIds, custom.memberIds);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});


test("offline SDK routing regression submits structured decisions without business tools and confirmation creates no discussion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-routing-sdk-")); const model = await createFakeModel();
  const service = await createService(createConfig({ server: { host: "127.0.0.1", accessKey: "routing-sdk" },
    model: { baseUrl: model.baseUrl, id: "fake", apiKey: "test-key" }, runtime: { dataDir: root }, tools: { browser: { enabled: false } } }));
  const headers = { authorization: `Bearer ${service.auth.login("routing-sdk")}`, "content-type": "application/json" };
  const send = async (id: string, content: string, targetAgentId?: string) => {
    const result = await service.app.request("/api/group/messages", { method: "POST", headers, body: JSON.stringify({ id, content, ...(targetAgentId ? { targetAgentId } : {}) }) });
    return (await result.text()).split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  };
  try {
    const original = "  ROUTE_CONFIRM original\n";
    const events = await send("ambiguous-sdk", original);
    assert.deepEqual(events.map((event) => event.type), ["suggestion", "settled"]);
    assert.equal(events[0].content, original); assert.deepEqual((await service.group.snapshot()).turns, []);
    assert.ok(model.requests.length > 0);
    for (const request of model.requests) assert.deepEqual(request.tools?.map((tool) => (tool as { function: { name: string } }).function.name), ["submit_group_route"]);
    const count = model.requests.length;
    const explicit = await send("explicit-sdk", events[0].content, "sms-internal");
    assert.equal(explicit.at(-1).type, "settled");
    assert.ok(model.requests.length > count);
    assert.ok(model.requests.slice(count).every((request) => !JSON.stringify(request.tools).includes("submit_group_route")));
    assert.equal((await service.group.snapshot()).turns[0]?.targetAgentId, "sms-internal");
    assert.equal((await service.group.snapshot()).turns[0]?.messages[0]?.content, original);
    const direct = await send("direct-sdk", "ROUTE_SMS original");
    assert.equal(direct.at(-1).type, "settled");
    const turn = (await service.group.snapshot()).turns.find((turn) => turn.id === "direct-sdk")!;
    assert.equal(turn.targetAgentId, "sms-internal"); assert.equal(turn.sourceAgentId, null); assert.equal(turn.messages[0]?.content, "ROUTE_SMS original");
  } finally { await service.close(); await model.close(); await rm(root, { recursive: true, force: true }); }
});
