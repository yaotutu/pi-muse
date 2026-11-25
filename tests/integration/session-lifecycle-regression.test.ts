import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm, stat, realpath, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createService, enableBuiltinSkills } from "../support/test-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const until = async (condition: () => Promise<boolean>) => {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not settle");
};
const fixture = async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-muse-agent-regression-"));
  let model: Awaited<ReturnType<typeof createFakeModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  const releaseGates: (() => void)[] = [];
  const stop = async () => {
    for (const release of releaseGates) release();
    try { await service?.close(); } finally {
      if (server && "closeAllConnections" in server) server.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  };
  t.after(async () => {
    try { await stop(); } finally {
      try { await model?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
    }
  });
  model = await createFakeModel();
  const config = createConfig({
    server: { host: "127.0.0.1" },
    model: { baseUrl: model.baseUrl, id: "test-model", apiKey: "fake-test-key" },
    runtime: { dataDir: dir, runTimeoutMs: 5000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    tools: { presentation: { overrides: { read: "summary" } } },
  });
  let baseUrl = "";
  const start = async () => {
    service = await createService(config);
    server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  await start();
  const request = (path: string, method = "GET", body?: unknown) => fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${service!.auth.login()}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const snapshot = async (id: string) => {
    const response = await request(`/api/conversation?sessionId=${id}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<{ piSessionId: string | null; messages: { role: string; content?: string }[]; revision: string }>;
  };
  const listed = async (id: string) => {
    const response = await request("/api/sessions");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sessions?: { id: string }[] };
    return (body.sessions || []).some((agent: { id: string }) => agent.id === id);
  };
  const run = async (id: string, text: string) => {
    const before = await snapshot(id);
    const response = await request("/api/conversation/run", "POST", {
      sessionId: id, runId: randomUUID(), expectedRevision: before.revision,
      message: { id: randomUUID(), content: text },
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, /RUN_FINISHED/);
    return stream;
  };
  return { dir, model, service: () => service!, request, snapshot, listed, run, releaseGates,
    restart: async () => { await stop(); await start(); } };
};
const assertMissing = async (path: string) => assert.rejects(stat(path), { code: "ENOENT" });

test("main is permanent, sessions have server UUIDs, titles and durable empty metadata", async (t) => {
  const h = await fixture(t);
  const initial = await (await h.request("/api/sessions")).json();
  assert.deepEqual(initial.sessions.map((s: {id: string}) => s.id), ["main"]);
  assert.equal(initial.sessions[0].title, "默认会话");
  const created = await h.request("/api/sessions", "POST", {});
  assert.equal(created.status, 200);
  const { session } = await created.json();
  assert.match(session.id, /^[a-f0-9-]{36}$/);
  assert.equal(session.title, "新会话");
  assert.equal((await h.request(`/api/sessions/${session.id}`, "PATCH", { title: "专题" })).status, 200);
  await h.restart();
  const after = await (await h.request("/api/sessions")).json();
  assert.equal(after.sessions[0].id, "main");
  assert.equal(after.sessions[1].title, "专题");
  const { scheduleRevision } = await (await h.request("/api/sessions/main/schedules")).json();
  const removeMain = await h.request("/api/sessions/main", "DELETE", { scheduleDisposition: "delete", scheduleRevision });
  assert.equal(removeMain.status, 409);
  assert.equal((await removeMain.json()).code, "CANNOT_DELETE_MAIN_SESSION");
  for (const id of ["legacy-main", "task-test", "not-a-uuid"]) {
    assert.equal((await h.request(`/api/conversation?sessionId=${id}`)).status, 400);
    assert.equal((await h.request("/api/conversation/run", "POST", { sessionId:id,runId:"invalid",expectedRevision:"empty",message:{id:"invalid",content:"hello"} })).status, 400);
  }
});

test("deletion cancels old references, late reads and stops never revive sessions", async (t) => {
  const h = await fixture(t);
  const { id } = await h.service().sessions.create("delete");
  await h.run(id, "hello before deletion");
  const old = await h.service().conversationHub.forSession(id);
  const entered = deferred(); const proceed = deferred();
  const removeJobs = h.service().jobs.removeByOriginSessionId;
  h.service().jobs.removeByOriginSessionId = async (origin) => { entered.resolve(); await proceed.promise; return removeJobs(origin); };
  h.releaseGates.push(proceed.resolve);
  const { scheduleRevision } = await (await h.request(`/api/sessions/${id}/schedules`)).json();
  const deletion = h.request(`/api/sessions/${id}`, "DELETE", { scheduleDisposition: "delete", scheduleRevision });
  await entered.promise;
  const during = await h.snapshot(id);
  assert.equal(during.piSessionId, null);
  assert.deepEqual(during.messages, []);
  assert.deepEqual(await (await h.request("/api/conversation/stop", "POST", { sessionId:id,runId:"old" })).json(), {stopped:false});
  const lateWrite = await h.request("/api/monitors", "POST", { originSessionId: id, url: "https://example.com/", condition: "change" });
  assert.equal(lateWrite.status, 409);
  proceed.resolve();
  assert.deepEqual(await (await deletion).json(), {ok:true,removed:{sessions:1,jobs:0,monitors:0},moved:{jobs:0,monitors:0}});
  await assertMissing(join(h.dir,"sessions",id));
  assert.equal(await h.listed(id), false);
  assert.equal((await h.snapshot(id)).piSessionId, null);
  await assert.rejects(old.notify("late notification", "late"));
  const lateRun = await h.request("/api/conversation/run", "POST", { sessionId:id,runId:"late",expectedRevision:"empty",message:{id:"late",content:"hello"} });
  assert.equal(lateRun.status, 404);
  await assertMissing(join(h.dir,"sessions",id));
});

test("instructions and workspace are shared while conversation JSONL is isolated", async (t) => {
  const h = await fixture(t);
  const a = await h.service().sessions.create("A"); const b = await h.service().sessions.create("B");
  assert.equal((await h.request(`/api/assistant/instructions`, "PUT", {instructions:"SHARED-PROMPT"})).status, 200);
  await h.run(a.id, "hello-A-ONLY");
  await h.run(b.id, "hello-B-ONLY");
  const prompts = h.model.requests.map((r) => JSON.stringify(r.messages));
  assert.ok(prompts.some((s) => s.includes("SHARED-PROMPT")));
  const bRequest = prompts.find((s) => s.includes("hello-B-ONLY"))!;
  assert.ok(bRequest);
  assert.match(bRequest, /SHARED-PROMPT/);
  assert.doesNotMatch(bRequest, /hello-A-ONLY/);
  assert.doesNotMatch(JSON.stringify(await h.snapshot(b.id)), /hello-A-ONLY/);
  const workspace = h.service().layout.workspaceDir;
  assert.deepEqual((await readdir(workspace)).sort(), ["assistant", "files", "subagents"]);
  await writeFile(join(workspace,"common.md"),"COMMON-FILE");
  await h.run(a.id,"读 common.md"); await h.run(b.id,"读 common.md");
  assert.match(JSON.stringify(await h.snapshot(a.id)),/COMMON-FILE/);
  assert.match(JSON.stringify(await h.snapshot(b.id)),/COMMON-FILE/);
  assert.deepEqual((await readdir(workspace)).sort(), ["assistant", "common.md", "files", "subagents"]);
});

test("subagent is a stateless self-contained function and creates no workspace or session directory", async (t) => {
  const h = await fixture(t);
  const sessionDirectories = async () => (await readdir(h.service().layout.sessionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const beforeDirs = await sessionDirectories();
  const beforeFiles = await readdir(h.service().layout.workspaceDir);
  await h.service().information.saveSettings({ enabled: true, batchWindowSeconds: 3600 });
  await enableBuiltinSkills(h.service(), ["skill-creator", "browser"]);
  await h.run("main", "子代理，问一下现在时间");
  assert.deepEqual(await sessionDirectories(), beforeDirs);
  assert.deepEqual(await readdir(h.service().layout.workspaceDir), beforeFiles);
  const child = h.model.requests.find((r) => JSON.stringify(r.messages).includes("specialized SMS subagent"));
  assert.ok(child, "must actually execute a child model request");
  const namesOf = (request: typeof child) => (request.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name).sort();
  assert.deepEqual(namesOf(child), ["currentTime", "sms_get_instructions", "sms_query", "sms_update_instructions"]);
  assert.match(JSON.stringify(await h.snapshot("main")), /SUBAGENT-MARKER/);
});

test("reset rotates only pi identity, cancels approvals and preserves title, rules, skills and files", async (t) => {
  const h = await fixture(t);
  const {id} = await h.service().sessions.create("保留标题");
  await h.run(id,"hello before reset");
  const before = await h.snapshot(id);
  await h.request(`/api/assistant/instructions`,"PUT",{instructions:"KEEP-RULE"});
  await h.request(`/api/assistant/skills`,"PUT",{overrides:{"builtin/web":false}});
  await writeFile(join(h.service().layout.workspaceDir,"keep.md"),"KEEP-FILE");
  const pending = await h.service().actions.submit("file_write","pending",{path:"keep.md",content:"new",originalContent:"KEEP-FILE",beforeExists:"true"},{sessionId:id,runId:"pending"});
  const reset = await h.request(`/api/sessions/${id}/reset`,"POST",{});
  assert.equal(reset.status,200);
  const result = await reset.json();
  assert.equal(result.session.id,id); assert.equal(result.session.title,"保留标题");
  assert.equal(result.cancelledApprovals,1);
  assert.equal(result.removed, undefined);
  assert.equal((await h.service().actions.get(pending.id))?.status,"cancelled");
  const after = await h.snapshot(id);
  assert.notEqual(after.piSessionId,before.piSessionId); assert.deepEqual(after.messages,[]);
  assert.equal((await (await h.request(`/api/assistant/instructions`)).json()).instructions,"KEEP-RULE");
  assert.equal((await h.service().skills.describe()).skills.find((s)=>s.name==="web")?.enabled,false);
  assert.equal(await readFile(join(h.service().layout.workspaceDir,"keep.md"),"utf8"),"KEEP-FILE");
});
test("missing-file diagnostics are safe in SSE, next model request, JSONL and reopened history", async (t) => {
  const h = await fixture(t);
  const { id } = await h.service().sessions.create("safe-file-error");
  const stream = await h.run(id, "读 absent-file.md");
  const messages = (await h.snapshot(id)).messages;
  const files = (await readdir(join(h.dir, "sessions", id, "history"))).filter((file) => file.endsWith(".jsonl"));
  const raw = (await Promise.all(files.map((file) => readFile(join(h.dir, "sessions", id, "history", file), "utf8")))).join("\n");
  const toolRecords = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult");
  assert.equal(toolRecords.length, 1);
  assert.match(JSON.stringify(toolRecords), /File not found/);
  const modelToolResults = h.model.requests.flatMap((request) => request.messages.filter((message) => message.role === "tool"));
  assert.ok(modelToolResults.length > 0);
  const physical = await realpath(h.dir);
  for (const value of [stream, JSON.stringify(messages), JSON.stringify(toolRecords), JSON.stringify(modelToolResults)]) {
    assert.ok(!value.includes(h.dir) && !value.includes(physical), value);
    assert.doesNotMatch(value, /ENOENT|lstat/);
  }
  assert.match(JSON.stringify(messages), /File not found/);
  await h.restart();
  assert.deepEqual((await h.snapshot(id)).messages, messages);
});


test("subagent ignores parent chat skills and custom extension hooks", async (t) => {
  const h = await fixture(t);
  await h.service().information.saveSettings({ enabled: true, batchWindowSeconds: 3600 });
  const skill = join(h.service().layout.skillsDir, "snapshot-scope");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: snapshot-scope\ndescription: Isolated extension permission regression.\n---\nUse the current tool set.\n");
  await h.service().skills.updateOverrides({
    "builtin/write": true, "builtin/skill-creator": true,
    "user/snapshot-scope": true,
  });
  await writeFile(join(skill, "extension.ts"), `export default function(pi) {
    pi.on("agent_start", () => {
      if (pi.getActiveTools().includes("subagent")) pi.setActiveTools(["subagent", "currentTime"]);
      else pi.setActiveTools(["write", "currentTime"]);
    });
  }`);
  await h.run("main", "子代理执行一个简单问题");
  const names = (request: typeof h.model.requests[number]) => (request.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name).sort();
  const child = h.model.requests.find((request) => JSON.stringify(request.messages).includes("specialized SMS subagent"))!;
  assert.ok(child);
  assert.deepEqual(names(child), ["currentTime", "sms_get_instructions", "sms_query", "sms_update_instructions"]);
  assert.deepEqual(await h.service().actions.list(), []);
  assert.deepEqual((await readdir(h.service().layout.workspaceDir)).sort(), ["assistant", "files", "subagents"]);
});

test("an admitted reset finishes before a queued delete validates its preview", async (t) => {
  const h = await fixture(t);
  const { id } = await h.service().sessions.create("reset before delete");
  await h.run(id, "hello before reset");
  const original = await h.snapshot(id);
  const entered = deferred();
  const proceed = deferred();
  h.releaseGates.push(proceed.resolve);
  const hub = h.service().conversationHub;
  const resetSession = hub.resetSession;
  hub.resetSession = (sessionId, onReset) => resetSession(sessionId, ({ closeCurrent, reopen }) => onReset({
    closeCurrent: async () => {
      await closeCurrent();
      entered.resolve();
      await proceed.promise;
    },
    reopen,
  }));

  const reset = h.request(`/api/sessions/${id}/reset`, "POST", {});
  await entered.promise;
  const deletion = h.request(`/api/sessions/${id}`, "DELETE", {
    scheduleDisposition: "delete",
    scheduleRevision: "0".repeat(64),
  });
  await until(async () => hub.isDeleting(id));
  proceed.resolve();
  assert.equal((await reset).status, 200);
  const rejected = await deletion;
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, "SESSION_SCHEDULES_CHANGED");
  const after = await h.snapshot(id);
  assert.ok(after.piSessionId);
  assert.notEqual(after.piSessionId, original.piSessionId);
  assert.deepEqual(after.messages, []);
});
