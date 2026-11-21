import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { skillsResponse, skillDetailResponse } from "../../src/http/contracts/responses.js";
import { createFakeModel } from "../support/fake-model.js";

const document = (name: string, description: string, body = "Use this guidance only when requested.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n${body}\n`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "shared-skills-http-"));
  const dataDir = join(root, "data");
  const sharedDir = join(root, "home", ".agents", "skills");
  const extensionSentinel = join(root, "extension-must-not-run.txt");
  const putSkill = async (directory: string, name: string, description: string, body?: string) => {
    const path = join(directory, name);
    await mkdir(path, { recursive: true });
    const content = document(name, description, body);
    await writeFile(join(path, "SKILL.md"), content);
    return { path, content };
  };
  await putSkill(sharedDir, "general-note", "SHARED_DISCOVERY_SENTINEL_93b");
  await writeFile(join(sharedDir, "general-note", "extension.ts"),
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(extensionSentinel)}, 'not allowed');export default function(){};`);
  await putSkill(sharedDir, "same-name", "LOW_PRIORITY_SHARED_BODY");
  await putSkill(sharedDir, "web", "SHARED_MUST_NOT_OVERRIDE_BUILTIN");
  const own = await putSkill(join(dataDir, "assets", "skills"), "same-name", "OWN_PRIORITY_BODY");
  const historicalConfig = '{"defaultEnabled":true}\n';
  await writeFile(join(own.path, "config.json"), historicalConfig);
  const model = await createFakeModel();
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  t.after(async () => {
    try { await service?.close(); }
    finally {
      if (server) {
        if ("closeAllConnections" in server) server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await model.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  service = await createService(createConfig({
    server: { host: "127.0.0.1", accessKey: "shared-skills-isolated-access" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-shared-skills-key", contextWindow: 128000 },
    runtime: { dataDir, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
  }), { sharedSkillsDir: sharedDir });
  server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(base + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "shared-skills-isolated-access" }) });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "PUT") => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  const run = async (content: string) => {
    const before = await (await request("/api/conversation")).json();
    const response = await request("/api/conversation/run", { sessionId: "main", runId: randomUUID(), expectedRevision: before.revision, message: { id: randomUUID(), content } }, "POST");
    assert.equal(response.status, 200);
    const events = (await response.text()).split(/\r?\n\r?\n/).filter((frame) => frame.startsWith("data:")).map((frame) => JSON.parse(frame.slice(5)));
    assert.equal(events.at(-1)?.type, "RUN_FINISHED");
  };
  return { root, dataDir, sharedDir, own, model, base, request, run, putSkill, extensionSentinel, historicalConfig };
}

test("shared skills HTTP: source-tagged catalog with shipped builtin defaults and authenticated full detail", async (t) => {
  const h = await fixture(t);
  const response = await h.request("/api/assistant/skills");
  assert.equal(response.status, 200);
  const catalog = skillsResponse.parse(await response.json());
  assert.ok(catalog.skills.length >= 10);
  assert.ok(catalog.skills.every((skill) => skill.defaultEnabled === (skill.source === "builtin")), "仅内置清单默认开启");
  assert.ok(catalog.skills.every((skill) => skill.enabled === skill.defaultEnabled), "无手动选择时按默认值生效");
  assert.ok(catalog.skills.filter((skill) => skill.source === "builtin").length >= 9);
  assert.equal(catalog.skills.find((skill) => skill.name === "same-name")?.source, "user");
  assert.equal(catalog.skills.find((skill) => skill.name === "web")?.source, "builtin");
  assert.equal(catalog.skills.find((skill) => skill.name === "general-note")?.id, "shared/general-note");
  assert.ok(catalog.diagnostics?.some((item) => item.path === "shared/same-name"));
  assert.ok(!JSON.stringify(catalog).includes(h.root));
  const detail = await h.request("/api/assistant/skills/general-note");
  assert.equal(detail.status, 200);
  const body = skillDetailResponse.parse(await detail.json());
  assert.equal(body.source, "shared");
  assert.equal(body.content, document("general-note", "SHARED_DISCOVERY_SENTINEL_93b"));
  assert.equal(body.enabled, false);
  assert.equal((await fetch(h.base + "/api/assistant/skills/general-note")).status, 401);
  assert.equal((await h.request("/api/assistant/skills/no-such-skill")).status, 404);
  assert.equal((await h.request("/api/assistant/skills/Bad_Name")).status, 400);
  assert.equal((await h.request(`/api/sessions/${randomUUID()}/skills/general-note`)).status, 404);
  assert.equal(await readFile(join(h.own.path, "config.json"), "utf8"), h.historicalConfig);
  assert.deepEqual((await readdir(join(h.sharedDir, "general-note"))).sort(), ["SKILL.md", "extension.ts"]);
});

test("shared skills runtime: explicit enable only, no shared code execution, and source switches do not inherit", async (t) => {
  const h = await fixture(t);
  await h.run("hello before selection");
  assert.ok(!JSON.stringify(h.model.requests[0]).includes("SHARED_DISCOVERY_SENTINEL_93b"));
  let response = await h.request("/api/assistant/skills", { overrides: { "shared/general-note": true } });
  assert.equal(response.status, 200);
  let view = skillsResponse.parse(await response.json());
  assert.equal(view.skills.find((skill) => skill.id === "shared/general-note")?.enabled, true);
  assert.ok(view.skills.filter((skill) => skill.enabled).every((skill) => skill.source === "builtin" || skill.id === "shared/general-note"));
  await h.run("hello after selection");
  assert.ok(JSON.stringify(h.model.requests.at(-1)).includes("SHARED_DISCOVERY_SENTINEL_93b"));
  await assert.rejects(stat(h.extensionSentinel), { code: "ENOENT" });
  const stored = JSON.parse(await readFile(join(h.dataDir, "state", "assistant", "skill-overrides.json"), "utf8"));
  assert.deepEqual(stored.overrides, { "shared/general-note": true });
  await h.putSkill(join(h.dataDir, "assets", "skills"), "general-note", "NEW_OWN_SOURCE");
  view = skillsResponse.parse(await (await h.request("/api/assistant/skills")).json());
  assert.equal(view.skills.find((skill) => skill.name === "general-note")?.source, "user");
  assert.equal(view.skills.find((skill) => skill.name === "general-note")?.enabled, false);
  response = await h.request("/api/assistant/skills", { overrides: { "shared/general-note": true } });
  assert.equal(response.status, 400);
  response = await h.request("/api/assistant/skills", { overrides: { "user/general-note": true } });
  assert.equal(response.status, 200);
  await h.request("/api/assistant/skills", { overrides: {} });
  await h.run("hello after disabling");
  assert.ok(!JSON.stringify(h.model.requests.at(-1)).includes("NEW_OWN_SOURCE"));
});

test("shared skills HTTP: unsafe and oversized entries remain unavailable without leaking filesystem paths", async (t) => {
  const h = await fixture(t);
  const secret = join(h.root, "outside.md");
  await writeFile(secret, document("linked-file", "PRIVATE_OUTSIDE_SENTINEL"));
  const linked = join(h.sharedDir, "linked-file");
  await mkdir(linked);
  await symlink(secret, join(linked, "SKILL.md"));
  await h.putSkill(h.sharedDir, "huge-body", "OVERSIZED", "x".repeat(102401));
  const view = skillsResponse.parse(await (await h.request("/api/assistant/skills")).json());
  assert.ok(!view.skills.some((skill) => ["linked-file", "huge-body"].includes(skill.name)));
  assert.ok(!JSON.stringify(view).includes(h.root));
  assert.ok(!JSON.stringify(view).includes("PRIVATE_OUTSIDE_SENTINEL"));
  assert.equal((await h.request("/api/assistant/skills/linked-file")).status, 404);
  assert.equal((await h.request("/api/assistant/skills/huge-body")).status, 404);
  const unknown = await h.request("/api/assistant/skills", { overrides: { "shared/missing": true } });
  assert.equal(unknown.status, 400);
  await assert.rejects(stat(join(h.dataDir, "state", "assistant", "skill-overrides.json")), { code: "ENOENT" });
});
