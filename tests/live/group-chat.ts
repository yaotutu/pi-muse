import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { parseLiveOptions, type LiveOptions } from "./options.js";
import { createTestClient, waitForTest } from "../support/http-client.js";
import { groupSnapshotSchema } from "../../src/http/contracts/group-chat.js";

/** 独立临时实例和透明真实模型代理；不读取原实例历史，不替换模型响应，不重试写请求。 */
const execute = async (options: LiveOptions) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const raw = JSON.parse(await readFile(options.configPath, "utf8"));
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured) throw new Error("Real model configuration is required");
  const root = await mkdtemp(join(tmpdir(), "pi-muse-group-live-"));
  const dataDir = join(root, "data");
  const proxy = await createLiveModel({ baseUrl: model.baseUrl!, apiKey: model.apiKey });
  const results: string[] = [];
  let scenario = "initialization";
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let baseUrl = "";
  const hits: { path: string; closed: boolean }[] = [];
  const fixture = createServer((req, res) => {
    const hit = { path: req.url ?? "", closed: false }; hits.push(hit);
    res.writeHead(200, { "Content-Type": "text/plain" }); res.write("Waiting for cancellation\n");
    res.on("close", () => { hit.closed = true; });
  });
  const config = createConfig({
    server: { host: "127.0.0.1", accessKey: "group-live-access" },
    model: { baseUrl: proxy.baseUrl, id: model.modelId, apiKey: "proxy-placeholder", contextWindow: model.contextWindow, maxTokens: model.maxTokens },
    runtime: { dataDir, runTimeoutMs: 180000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    tools: { browser: { enabled: false }, web: { allowPrivateTargets: true, timeoutMs: 60000 } },
  });
  const start = async () => {
    service = await createService(config);
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address(); assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  };
  const stop = async () => {
    try { await service?.close(); } finally {
      if (http && "closeAllConnections" in http) http.closeAllConnections();
      if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
      http = undefined; service = undefined;
    }
  };
  const pass = () => { results.push(scenario); process.stdout.write(`[PASS] ${scenario}\n`); };
  try {
    await mkdir(dataDir, { recursive: true });
    // 模拟首次执行在 pi 创建 JSONL 前失败的真实索引；下一条不能永远卡在旧讨论 NOT_FOUND。
    await writeFile(join(dataDir, "group.json"), JSON.stringify([{ id: "failed-before-pi", rootId: "failed-before-pi", sourceAgentId: null,
      targetAgentId: "news-internal", discussionId: randomUUID(), createdAt: new Date().toISOString(), finishedAt: null, status: "failed" }]));
    await start();
    fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
    const address = fixture.address(); assert.ok(address && typeof address !== "string");
    const login = await fetch(baseUrl + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "group-live-access" }) });
    const { token } = await login.json();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const client = createTestClient(() => baseUrl, token, 190000);
    const group = async () => groupSnapshotSchema.parse(await client.json("/api/group"));
    const post = (id: string, content: string, targetAgentId?: string, signal?: AbortSignal) => fetch(baseUrl + "/api/group/messages", {
      method: "POST", headers, body: JSON.stringify({ id, content, ...(targetAgentId ? { targetAgentId } : {}) }), signal,
    });
    const send = async (id: string, content: string, target?: string) => {
      const response = await post(id, content, target); assert.equal(response.status, 200);
      const frames = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
      assert.equal(frames.at(-1)?.type, "settled", JSON.stringify(frames.filter((frame) => frame.type === "error")));
      const turn = (await group()).turns.find((turn) => turn.id === id)!;
      assert.equal(turn.status, "completed"); assert.equal(turn.targetAgentId, target ?? "local-main");
      assert.ok(turn.messages.some((message) => message.role === "assistant")); return turn;
    };
    const before = await Promise.all(["local-main", "sms-internal", "news-internal"].map((id) => client.json(`/api/conversation?agentId=${id}`)));
    scenario = "default-main-explicit-target-and-prompt-isolation";
    await send("main-first", "Remember MAIN_GROUP_CEDAR_381. Reply only MAIN_READY. Do not use tools.");
    await send("sms-first", "Remember SMS_GROUP_WAVE_927. Reply only SMS_READY. Do not use tools.", "sms-internal");
    await send("main-followup", "Reply only MAIN_FOLLOWUP. Do not use tools.");
    await send("sms-followup", "Reply only SMS_FOLLOWUP. Do not use tools.", "sms-internal");
    for (const [followup, own, other] of [["MAIN_FOLLOWUP", "MAIN_GROUP_CEDAR_381", "SMS_GROUP_WAVE_927"], ["SMS_FOLLOWUP", "SMS_GROUP_WAVE_927", "MAIN_GROUP_CEDAR_381"]]) {
      const traces = proxy.traces.filter((trace) => trace.users.some((text) => text.includes(followup!)));
      assert.ok(traces.length); for (const trace of traces) { assert.ok(JSON.stringify(trace.users).includes(own!)); assert.ok(!JSON.stringify(trace.users).includes(other!)); }
    }
    pass();
    scenario = "actual-nested-agent-request-and-private-isolation";
    await send("nested-request", "Use agent action=request to ask sms-internal to reply only NESTED_GROUP_OK. Pass only that instruction, no other context. Then tell me the answer. Do not use other tools.");
    const nested = (await group()).turns.find((turn) => turn.rootId === "nested-request" && turn.sourceAgentId === "local-main");
    assert.ok(nested); assert.equal(nested.targetAgentId, "sms-internal"); assert.equal(nested.status, "completed");
    assert.ok(proxy.traces.some((trace) => trace.calls.some((call) => call.name === "agent")));
    assert.deepEqual(await Promise.all(["local-main", "sms-internal", "news-internal"].map((id) => client.json(`/api/conversation?agentId=${id}`))), before);
    pass();
    scenario = "missing-first-discussion-recovery-without-replay";
    await send("news-recovered", "Reply only NEWS_RECOVERED. Do not use tools.", "news-internal"); pass();
    scenario = "persisted-group-restart-and-invalid-target";
    const saved = await group(); await stop(); await start(); assert.deepEqual(await group(), saved);
    assert.match(await (await post("main-first", "Must not replay")).text(), /BUSY/);
    assert.match(await (await post("invalid-target", "Must not fallback", "missing-group-member")).text(), /NOT_FOUND/); pass();
    scenario = "reset-delete-clear-only-target-group-discussions";
    const others = (await group()).turns.filter((turn) => turn.targetAgentId !== "news-internal");
    await client.json("/api/agents/news-internal/reset", {});
    assert.deepEqual((await group()).turns, others);
    await assert.rejects(readdir(join(dataDir, "sessions", "news-internal", "discussions")), { code: "ENOENT" });
    await client.json("/api/agents/group-worker/instructions", { instructions: "Answer concise requests. Do not delegate." }, "PUT");
    await send("worker-message", "Reply only GROUP_WORKER_OK. Do not use tools.", "group-worker");
    await client.json("/api/agents/group-worker", undefined, "DELETE");
    assert.deepEqual((await group()).turns, others);
    await assert.rejects(readdir(join(dataDir, "sessions", "group-worker")), { code: "ENOENT" });
    pass();
    scenario = "stop-and-disconnect-cancel-real-tool-sockets";
    for (const kind of ["stop", "disconnect"]) {
      const id = `group-${kind}`; const controller = new AbortController();
      const response = await post(id, `Use web_fetch to fetch http://127.0.0.1:${address.port}/${kind} now. Wait for the full response. Do not delegate or use other tools.`, undefined, controller.signal);
      const body = response.text(); void body.catch(() => undefined);
      await waitForTest(() => hits.some((hit) => hit.path === `/${kind}`), "real fetch started", 90000);
      if (kind === "stop") { assert.deepEqual(await client.json(`/api/group/messages/${id}/stop`, {}), { stopped: true }); await body; }
      else { controller.abort(); await assert.rejects(body); }
      await waitForTest(async () => { const state = await group(); return !state.running && state.turns.find((turn) => turn.id === id)?.status === "cancelled"; }, "cancelled group", 30000);
      await waitForTest(() => hits.some((hit) => hit.path === `/${kind}` && hit.closed), "cancelled socket", 30000);
      assert.deepEqual(await client.json(`/api/group/messages/${id}/stop`, {}), { stopped: false });
    }
    pass();
  } catch (error) {
    process.stderr.write(`[FAIL] ${scenario}: ${redactApiKey(error instanceof Error ? error.message : "Group live failed", model.apiKey)}\n`); process.exitCode = 1;
  } finally {
    await stop(); fixture.closeAllConnections();
    if (fixture.listening) await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await proxy.close();
    if (options.keepArtifacts) {
      await writeFile(join(root, "summary.json"), redactApiKey(JSON.stringify({ results, scenario, externalRequests: proxy.traces.length, traces: proxy.traces, hits }, null, 2), model.apiKey));
      process.stdout.write(`Evidence: ${root}\n`);
    } else await rm(root, { recursive: true, force: true });
  }
};
const parsed = parseLiveOptions(process.argv.slice(2));
if (parsed.kind === "help") process.stdout.write(parsed.help.replace("pnpm test:live", "node --import tsx tests/live/group-chat.ts"));
else if (parsed.kind === "error") { process.stderr.write(parsed.message + "\n"); process.exitCode = 1; }
else await execute(parsed.options);
