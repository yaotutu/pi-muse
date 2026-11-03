import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createSpaceResponse } from "../../src/http/contracts/responses.js";

test("explicit empty member survives service restart and duplicate creation never resets the space", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-member-create-"));
  const config = createConfig({ server: { host: "127.0.0.1", accessKey: "member-create-test" }, runtime: { dataDir: root }, tools: { browser: { enabled: false } } });
  let service = await createService(config);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const login = async () => {
    const response = await service.app.request("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "member-create-test" }) });
    return (await response.json()).token as string;
  };
  let token = await login();
  const request = (path: string, method = "GET", body?: unknown) => service.app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await service.app.request("/api/spaces", { method: "POST", body: "{}" })).status, 401);
  for (const spaceId of ["../other", "sms-internal", "news-internal", "task-hidden", "with space", ""]) {
    assert.equal((await request("/api/spaces", "POST", { spaceId })).status, 400);
  }
  const created = await request("/api/spaces", "POST", { spaceId: "empty-member" });
  assert.equal(created.status, 200);
  const first = createSpaceResponse.parse(await created.json()).space;
  assert.equal(first.id, "empty-member");
  assert.ok(first.sessionId);
  assert.ok((await (await request("/api/members")).json()).members.some((member: { id: string }) => member.id === first.id));
  assert.deepEqual((await (await request("/api/conversation?spaceId=empty-member")).json()).messages, []);
  await request("/api/spaces/empty-member/instructions", "PUT", { instructions: "Keep these rules" });
  const again = createSpaceResponse.parse(await (await request("/api/spaces", "POST", { spaceId: "empty-member" })).json()).space;
  assert.equal(again.sessionId, first.sessionId);
  assert.equal((await (await request("/api/spaces/empty-member/instructions")).json()).instructions, "Keep these rules");
  await service.close();
  service = await createService(config);
  token = await login();
  assert.ok((await (await request("/api/members")).json()).members.some((member: { id: string }) => member.id === "empty-member"));
  assert.deepEqual((await (await request("/api/conversation?spaceId=empty-member")).json()).messages, []);
});
