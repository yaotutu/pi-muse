import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readdir, readFile, writeFile, rm, stat, realpath, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { createFakeModel } from "../support/fake-model.js";
import { createMonitorScheduler } from "../../src/features/monitors/monitor-scheduler.js";

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
  const removeMain = await h.request("/api/sessions/main", "DELETE");
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
  const deletion = h.request(`/api/sessions/${id}`, "DELETE");
  await entered.promise;
  const during = await h.snapshot(id);
  assert.equal(during.piSessionId, null);
  assert.deepEqual(during.messages, []);
  assert.deepEqual(await (await h.request("/api/conversation/stop", "POST", { sessionId:id,runId:"old" })).json(), {stopped:false});
  const lateWrite = await h.request(`/api/sessions/${id}/instructions`, "PUT", {instructions:"late"});
  assert.equal(lateWrite.status, 409);
  proceed.resolve();
  assert.deepEqual(await (await deletion).json(), {ok:true,removed:{sessions:1}});
  await assertMissing(join(h.dir,"sessions",id));
  assert.equal(await h.listed(id), false);
  assert.equal((await h.snapshot(id)).piSessionId, null);
  await assert.rejects(old.notify("late notification", "late"));
  const lateRun = await h.request("/api/conversation/run", "POST", { sessionId:id,runId:"late",expectedRevision:"empty",message:{id:"late",content:"hello"} });
  assert.equal(lateRun.status, 404);
  await assertMissing(join(h.dir,"sessions",id));
});

test("conversation instructions and JSONL are isolated while workspace stays flat and shared", async (t) => {
  const h = await fixture(t);
  const a = await h.service().sessions.create("A"); const b = await h.service().sessions.create("B");
  assert.equal((await h.request(`/api/sessions/${a.id}/instructions`, "PUT", {instructions:"A-ONLY-PROMPT"})).status, 200);
  await h.run(a.id, "hello-A-ONLY");
  await h.run(b.id, "hello-B-ONLY");
  const prompts = h.model.requests.map((r) => JSON.stringify(r.messages));
  assert.ok(prompts.some((s) => s.includes("A-ONLY-PROMPT")));
  const bRequest = prompts.find((s) => s.includes("hello-B-ONLY"))!;
  assert.ok(bRequest);
  assert.doesNotMatch(bRequest, /A-ONLY-PROMPT|hello-A-ONLY|短信过滤与通知规则/);
  assert.doesNotMatch(JSON.stringify(await h.snapshot(b.id)), /hello-A-ONLY/);
  const workspace = h.service().layout.workspaceDir;
  assert.deepEqual(await readdir(workspace), []);
  await writeFile(join(workspace,"common.md"),"COMMON-FILE");
  await h.run(a.id,"读 common.md"); await h.run(b.id,"读 common.md");
  assert.match(JSON.stringify(await h.snapshot(a.id)),/COMMON-FILE/);
  assert.match(JSON.stringify(await h.snapshot(b.id)),/COMMON-FILE/);
  assert.deepEqual(await readdir(workspace), ["common.md"]);
});

test("subagent is an in-memory function and creates no workspace or session directory", async (t) => {
  const h = await fixture(t);
  const beforeDirs = await readdir(join(h.dir,"sessions"));
  const beforeFiles = await readdir(h.service().layout.workspaceDir);
  await h.service().information.saveSettings({enabled:true,batchWindowSeconds:3600});
  await h.run("main", "子代理，问一下现在时间");
  assert.deepEqual(await readdir(join(h.dir,"sessions")), beforeDirs);
  assert.deepEqual(await readdir(h.service().layout.workspaceDir), beforeFiles);
  const child = h.model.requests.find((r) => JSON.stringify(r.messages).includes("## Subagent role"));
  assert.ok(child,"must actually execute a child model request");
  const namesOf=(request:typeof child)=>(request.tools??[]).map((tool)=>(tool as {function:{name:string}}).function.name).sort();
  const parent=h.model.requests.find((request)=>!JSON.stringify(request.messages).includes("## Subagent role"))!;
  const blocked=new Set(["bash","subagent","schedule","monitor","activity","instructions"]);
  assert.deepEqual(namesOf(child),namesOf(parent).filter((name)=>!blocked.has(name)));
  for(const inherited of ["skills","navigate","information"])assert.ok(namesOf(child).includes(inherited),inherited);
  assert.match(JSON.stringify(await h.snapshot("main")), /SUBAGENT-MARKER/);
});

test("reset rotates only pi identity, cancels approvals and preserves title, rules, skills and files", async (t) => {
  const h = await fixture(t);
  const {id} = await h.service().sessions.create("保留标题");
  await h.run(id,"hello before reset");
  const before = await h.snapshot(id);
  await h.request(`/api/sessions/${id}/instructions`,"PUT",{instructions:"KEEP-RULE"});
  await h.request(`/api/sessions/${id}/skills`,"PUT",{overrides:{task:false}});
  await writeFile(join(h.service().layout.workspaceDir,"keep.md"),"KEEP-FILE");
  const pending = await h.service().actions.submit("file_write","pending",{path:"keep.md",content:"new",originalContent:"KEEP-FILE",beforeExists:"true"},{sessionId:id,runId:"pending"});
  const reset = await h.request(`/api/sessions/${id}/reset`,"POST",{});
  assert.equal(reset.status,200);
  const result = await reset.json();
  assert.equal(result.session.id,id); assert.equal(result.session.title,"保留标题");
  assert.equal(result.cancelledApprovals,1);
  assert.deepEqual(result.removed,{jobs:0,monitors:0});
  assert.equal((await h.service().actions.get(pending.id))?.status,"cancelled");
  const after = await h.snapshot(id);
  assert.notEqual(after.piSessionId,before.piSessionId); assert.deepEqual(after.messages,[]);
  assert.equal((await (await h.request(`/api/sessions/${id}/instructions`)).json()).instructions,"KEEP-RULE");
  assert.equal((await h.service().skills.describeSession(id)).skills.find((s)=>s.name==="task")?.enabled,false);
  assert.equal(await readFile(join(h.service().layout.workspaceDir,"keep.md"),"utf8"),"KEEP-FILE");
});
test("missing-file diagnostics are safe in SSE, next model request, JSONL and reopened history", async (t) => {
  const h = await fixture(t);
  const { id } = await h.service().sessions.create("safe-file-error");
  const stream = await h.run(id, "读 absent-file.md");
  const messages = (await h.snapshot(id)).messages;
  const files = (await readdir(join(h.dir, "sessions", id))).filter((file) => file.endsWith(".jsonl"));
  const raw = (await Promise.all(files.map((file) => readFile(join(h.dir, "sessions", id, file), "utf8")))).join("\n");
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


test("subagent uses the SDK active-tool snapshot and extension hooks cannot reactivate child tools",async(t)=>{
  const h=await fixture(t);
  await mkdir(h.service().layout.subagentsDir,{recursive:true});
  await writeFile(join(h.service().layout.subagentsDir,"worker.md"),"---\nname: worker\ndescription: Role may only narrow the parent snapshot.\ntools: currentTime, write, skills, subagent\n---\nReturn a concise result.\n");
  const skill=join(h.service().layout.skillsDir,"snapshot-scope");
  await mkdir(skill,{recursive:true});
  await writeFile(join(skill,"SKILL.md"),"---\nname: snapshot-scope\ndescription: Isolated extension permission regression.\n---\nUse the current tool set.\n");
  await writeFile(join(skill,"config.json"),JSON.stringify({defaultEnabled:true}));
  await writeFile(join(skill,"extension.ts"),`export default function(pi) {
    pi.on("agent_start", () => {
      if (pi.getActiveTools().includes("subagent")) pi.setActiveTools(["subagent", "currentTime"]);
      else pi.setActiveTools(["write", "currentTime"]);
    });
  }`);
  await h.run("main","子代理执行一个简单问题");
  const names=(request:typeof h.model.requests[number])=>(request.tools??[]).map((tool)=>(tool as {function:{name:string}}).function.name).sort();
  const parent=h.model.requests.find((request)=>!JSON.stringify(request.messages).includes("## Subagent role"))!;
  const child=h.model.requests.find((request)=>JSON.stringify(request.messages).includes("## Subagent role"))!;
  assert.ok(child);
  assert.ok(names(parent).includes("subagent"));
  // 父装配候选含 write，但子调用接纳时 SDK 活跃快照已被可信扩展收窄。
  assert.ok(names(parent).includes("write"));
  assert.deepEqual(names(child),["currentTime"]);
  assert.deepEqual(await h.service().actions.list(),[]);
  assert.deepEqual(await readdir(h.service().layout.workspaceDir),[]);
});
