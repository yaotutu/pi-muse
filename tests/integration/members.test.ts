import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { membersResponse } from "../../src/http/contracts/responses.js";

test("member directory is authenticated, read-only and retains feature ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-members-"));
  const service = await createService(createConfig({ server: { host: "127.0.0.1" }, runtime: { dataDir: root } }));
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${service.auth.login()}`, "content-type": "application/json" };
  assert.equal((await service.app.request("/api/members")).status, 401);
  const before = await service.conversationHub.spaces();
  const read = await service.app.request("/api/members", { headers });
  const { members } = membersResponse.parse(await read.json());
  assert.ok(members.some((member) => member.id === "sms-internal" && member.kind === "feature"));
  assert.equal(members.find((member) => member.id === "sms-internal")!.sessionId,
    before.find((space) => space.id === "sms-internal")?.sessionId ?? null);
  assert.ok(members.some((member) => member.id === "news-internal" && member.name === "新闻"));
  assert.deepEqual(await service.conversationHub.spaces(), before);
  for (const id of ["news-internal", "sms-internal"]) {
    const files = await service.app.request(`/api/workspace/files?scope=space&spaceId=${id}&path=.`, { headers });
    assert.equal(files.status, 200);
    assert.equal((await files.json()).spaceId, id);
    const deleted = await service.app.request(`/api/spaces/${id}`, { method: "DELETE", headers });
    assert.equal(deleted.status, 409);
  }
  assert.equal((await service.information.getSettings("sms-internal")).enabled, false);
});
