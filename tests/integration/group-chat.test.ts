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
  assert.ok(groupSendSchema.safeParse({ id: "group-two", content: "hello", targetSpaceId: "sms-internal" }).success);
  for (const extra of [{ messages: [] }, { targets: ["local-main", "sms-internal"] }, { targetSpaceId: "../escape" }, { content: " " }])
    assert.equal(groupSendSchema.safeParse({ id: "group-three", content: "hello", ...extra }).success, false);
  const doc = JSON.stringify(buildOpenApiDocument());
  for (const value of ["/api/group", "只交给 local-main", "不广播", "群时间线注入模型", "无心跳", "结果未明", "不自动重发", "私聊上下文独立"])
    assert.ok(doc.includes(value), value);
});

test("group GET is authenticated and side-effect-free; a corrupt index cannot silently become empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-group-contract-"));
  const service = await createService(createConfig({ server: { host: "127.0.0.1", accessKey: "group-test" }, runtime: { dataDir: root }, tools: { browser: { enabled: false } } }));
  try {
    assert.equal((await service.app.request("/api/group")).status, 401);
    const headers = { authorization: `Bearer ${service.auth.login("group-test")}` };
    const response = await service.app.request("/api/group", { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(groupSnapshotSchema.parse(await response.json()), { id: "main", defaultSpaceId: "local-main", turns: [], running: null });
    await assert.rejects(readFile(join(root, "group.json")), { code: "ENOENT" });
    assert.equal((await service.app.request("/api/group/messages", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ id: "bad", content: "hello", messages: [] }) })).status, 400);
    await writeFile(join(root, "broken-group.json"), "not-json");
    await assert.rejects(createGroupRepository(join(root, "broken-group.json")).read(), /Invalid group document/);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
