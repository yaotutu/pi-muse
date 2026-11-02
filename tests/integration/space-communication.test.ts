import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { communicationSpacesResponse, spaceRequestSchema } from "../../src/http/contracts/space-communication.js";
import { buildOpenApiDocument } from "../../src/http/openapi.js";
import { registeredToolNames } from "../../src/adapters/pi/tools/index.js";

test("space request contract accepts both directions without a space allowlist or notification binding", () => {
  for (const [sourceSpaceId, targetSpaceId] of [["local-main", "sms-internal"], ["sms-internal", "local-main"], ["research", "travel"], ["news-internal", "sms-internal"]]) {
    assert.equal(spaceRequestSchema.safeParse({ sourceSpaceId, targetSpaceId, message: "Please process this request" }).success, true);
  }
  for (const patch of [{ message: " " }, { message: "a".repeat(20001) }, { targetSpaceId: "../escape" }, { discussionId: "../escape" }, { permission: "allow" }]) {
    assert.equal(spaceRequestSchema.safeParse({ sourceSpaceId: "local-main", targetSpaceId: "sms-internal", message: "request", ...patch }).success, false);
  }
  assert.ok(registeredToolNames.includes("space"));
});

test("space communication discovery, authentication and missing history use real HTTP without a provider substitute", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-space-contract-"));
  const service = await createService(createConfig({ server: { host: "127.0.0.1", accessKey: "space-contract-access" }, runtime: { dataDir: root }, tools: { browser: { enabled: false } } }));
  const http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!http.listening) await once(http, "listening");
    const address = http.address(); assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(baseUrl + "/api/space-communication/spaces")).status, 401);
    const login = await fetch(baseUrl + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "space-contract-access" }) });
    const { token } = await login.json();
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const main = await service.conversationHub.findSpace("local-main");
    const before = await main!.snapshot();
    const response = await fetch(baseUrl + "/api/space-communication/spaces", { headers });
    assert.equal(response.status, 200);
    const listed = communicationSpacesResponse.parse(await response.json());
    assert.ok(listed.spaces.some((space) => space.id === "sms-internal" && space.kind === "feature"));
    assert.ok(listed.spaces.some((space) => space.id === "news-internal" && space.kind === "feature"));
    const ordinary = await (await fetch(baseUrl + "/api/spaces", { headers })).json();
    assert.ok(!ordinary.spaces.some((space: { id: string }) => space.id === "sms-internal"));
    const missing = await fetch(baseUrl + "/api/space-communication/discussions/sms-internal/00000000-0000-4000-8000-000000000000", { headers });
    assert.equal(missing.status, 404);
    assert.equal((await fetch(baseUrl + "/api/space-communication/requests", { method: "POST", headers, body: JSON.stringify({ sourceSpaceId: "local-main", targetSpaceId: "does-not-exist", message: "test" }) })).status, 404);
    assert.equal((await fetch(baseUrl + "/api/space-communication/requests", { method: "POST", headers, body: JSON.stringify({ sourceSpaceId: "local-main", targetSpaceId: "sms-internal", message: " " }) })).status, 400);
    assert.equal((await main!.snapshot()).revision, before.revision);
    await assert.rejects(readdir(join(root, "sessions", "does-not-exist")), { code: "ENOENT" });
    await assert.rejects(readdir(join(root, "sessions", "sms-internal", "discussions")), { code: "ENOENT" });
  } finally {
    await service.close(); if ("closeAllConnections" in http) http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("space communication OpenAPI documents replies, context ownership, cancellation and separate notification routing", () => {
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { description?: string; responses: unknown }>> };
  const operation = doc.paths["/api/space-communication/requests"]!.post!;
  for (const text of ["独立讨论", "不复制", "不走普通通知队列", "discussionId", "不自动重试", "断开请求", "reset/delete", "模型文件修改审批", "completed"]) {
    const serialized = JSON.stringify(operation);
    assert.ok(serialized.includes(text), `Missing communication semantics: ${text}`);
  }
  assert.ok(doc.paths["/api/space-communication/spaces"]!.get!.description!.includes("默认互信"));
  assert.ok(doc.paths["/api/space-communication/discussions/{targetSpaceId}/{discussionId}"]!.get);
});
