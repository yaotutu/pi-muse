import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createAgentResponse } from "../../src/http/contracts/responses.js";

test("legacy private roots refuse startup before initialization and preserve original bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-muse-agent-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldRoot = join(root, "workspace", "threads", "local-main");
  await mkdir(oldRoot, { recursive: true });
  const original = "Existing private data must not be replaced";
  await writeFile(join(oldRoot, "notes.md"), original);
  const config = createConfig({ server: {}, runtime: { dataDir: root }, tools: { browser: { enabled: false } } });
  await assert.rejects(createService(config), /Legacy Space data layout/);
  assert.deepEqual(await readdir(root), ["workspace"]);
  assert.deepEqual(await readdir(join(root, "workspace")), ["threads"]);
  assert.equal(await readFile(join(oldRoot, "notes.md"), "utf8"), original);
});

test("explicit empty member survives service restart and duplicate creation never resets the agent", async (t) => {
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
  assert.equal((await service.app.request("/api/agents", { method: "POST", body: "{}" })).status, 401);
  for (const agentId of ["../other", "sms-internal", "news-internal", "task-hidden", "with agent", ""]) {
    assert.equal((await request("/api/agents", "POST", { agentId })).status, 400);
  }
  const created = await request("/api/agents", "POST", { agentId: "empty-member" });
  assert.equal(created.status, 200);
  const first = createAgentResponse.parse(await created.json()).agent;
  assert.equal(first.id, "empty-member");
  assert.ok(first.sessionId);
  assert.ok((await (await request("/api/agents")).json()).agents.some((member: { id: string }) => member.id === first.id));
  assert.deepEqual((await (await request("/api/conversation?agentId=empty-member")).json()).messages, []);
  await request("/api/agents/empty-member/instructions", "PUT", { instructions: "Keep these rules" });
  const again = createAgentResponse.parse(await (await request("/api/agents", "POST", { agentId: "empty-member" })).json()).agent;
  assert.equal(again.sessionId, first.sessionId);
  assert.equal((await (await request("/api/agents/empty-member/instructions")).json()).instructions, "Keep these rules");
  await service.close();
  service = await createService(config);
  token = await login();
  assert.ok((await (await request("/api/agents")).json()).agents.some((member: { id: string }) => member.id === "empty-member"));
  assert.deepEqual((await (await request("/api/conversation?agentId=empty-member")).json()).messages, []);
});
