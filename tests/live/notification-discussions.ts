import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createService } from "../../src/bootstrap/create-service.js";
import { createConfig } from "../../src/config/load-config.js";
import { groupSnapshotSchema } from "../../src/http/contracts/group-chat.js";
import { createLiveModel, redactApiKey } from "../support/live-model.js";
import { parseLiveOptions, type LiveOptions } from "./options.js";
import { waitForTest } from "../support/http-client.js";

/** 通知使用真实 PI marker，模型走透明外部代理；正文、路由和隔离均从实际状态核查。 */
async function execute(options: LiveOptions) {
  const raw = JSON.parse(await readFile(options.configPath, "utf8"));
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured) throw new Error("Real model configuration required");
  const proxy = await createLiveModel({ baseUrl: model.baseUrl!, apiKey: model.apiKey });
  const root = await mkdtemp(join(tmpdir(), "pi-muse-notification-discussions-"));
  const config = createConfig({ server: { host: "127.0.0.1", accessKey: "notification-live" },
    runtime: { dataDir: join(root, "data"), runTimeoutMs: 180000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    model: { baseUrl: proxy.baseUrl, id: model.modelId, apiKey: "proxy-placeholder", contextWindow: model.contextWindow, maxTokens: model.maxTokens },
    tools: { browser: { enabled: false }, web: { enabled: false } } });
  let service!: Awaited<ReturnType<typeof createService>>;
  let http: ReturnType<typeof serve> | undefined;
  let base = "";
  let headers!: Record<string, string>;
  const results: string[] = [];
  const start = async () => {
    service = await createService(config);
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address(); assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
    headers = { authorization: `Bearer ${service.auth.login("notification-live")}`, "content-type": "application/json" };
  };
  const stop = async () => {
    await service?.close();
    if (http && "closeAllConnections" in http) http.closeAllConnections();
    if (http) await new Promise<void>((resolve) => http!.close(() => resolve()));
    http = undefined;
  };
  const get = async (path: string) => { const response = await fetch(base + path, { headers }); assert.equal(response.status, 200); return response.json(); };
  const group = async () => groupSnapshotSchema.parse(await get("/api/group"));
  const send = async (input: object) => {
    const response = await fetch(base + "/api/group/messages", { method: "POST", headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    return (await response.text()).split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
  };
  const pass = (name: string) => { results.push(name); process.stdout.write(`[PASS] ${name}\n`); };
  try {
    await start();
    const main = await service!.conversationHub.forAgent("local-main");
    await service.information.saveSettings("sms-internal", { enabled: true, batchWindowSeconds: 3600 });
    const items = await service.information.ingest("sms-internal", [
      { source: "synthetic", externalId: "travel", content: "RAW_TRAVEL_DETAIL_891: arrive thirty minutes before departure." },
      { source: "synthetic", externalId: "bill", content: "RAW_BILL_DETAIL_284: monthly broadband charge." },
    ]);
    await service.information.saveSettings("sms-internal", { enabled: false, batchWindowSeconds: 3600 });
    const a = await main.notify("出行提醒 TRAVEL_CEDAR_381：明天九点出发。", "notice-a", { featureSource: { featureId: "sms", itemIds: [items[0]!.id] } });
    const b = await main.notify("账单提醒 BILL_WAVE_927：请核对宽带账单。", "notice-b", { featureSource: { featureId: "sms", itemIds: [items[1]!.id] } });
    const ref = (receipt: typeof a) => ({ targetAgentId: "local-main", sessionId: receipt.sessionId, messageId: receipt.messageId });
    const before = await Promise.all(["local-main", "sms-internal", "news-internal"].map((id) => get(`/api/conversation?agentId=${id}`)));
    await service!.features.bind("sms", "news-internal");
    for (const input of [
      { id: "ordinary-main", content: "Remember MAIN_CONTEXT_462. Reply only MAIN_READY. Do not use tools." },
      { id: "notice-a-first", content: "Remember FOLLOWUP_A_713. Use information action=item to read the source itemId in the supporting context, then reply only A_READY. Do not use other tools.", notification: ref(a) },
      { id: "notice-a-next", content: "Reply only A_CONTINUED. Do not use tools.", notification: ref(a) },
      { id: "notice-b-first", content: "Reply only B_READY. Do not use tools.", notification: ref(b) },
      { id: "ordinary-sms", content: "Reply only NORMAL_SMS_READY. Do not use tools.", targetAgentId: "sms-internal" },
    ]) {
      const events = await send(input); assert.equal(events.at(-1)?.type, "settled", JSON.stringify(events.filter((event) => event.type === "error")));
      const turn = (await group()).turns.find((item) => item.id === input.id)!;
      assert.equal(turn.status, "completed"); assert.equal(turn.targetAgentId, input.id === "ordinary-main" ? "local-main" : "sms-internal");
    }
    const state = await group();
    const aTurns = state.turns.filter((item) => item.notification?.messageId === a.messageId);
    assert.equal(aTurns.length, 2); assert.equal(aTurns[0]!.discussionId, aTurns[1]!.discussionId);
    assert.equal(new Set(state.turns.map((item) => item.discussionId)).size, 4);
    const trace = (marker: string) => { const values = proxy.traces.filter((item) => item.users.some((text) => text.includes(marker))); assert.ok(values.length); return JSON.stringify(values.map((item) => item.users)); };
    assert.ok(trace("A_CONTINUED").includes("TRAVEL_CEDAR_381"));
    assert.ok(trace("A_CONTINUED").includes("FOLLOWUP_A_713"));
    assert.ok(trace("A_CONTINUED").includes("its own dedicated discussion"));
    assert.ok(!trace("A_CONTINUED").includes("The user is speaking to you in the shared group chat"));
    assert.ok(trace("MAIN_READY").includes("The user is speaking to you in the shared group chat"));
    assert.ok(proxy.traces.some((item) => item.calls.some((call) => call.name === "information")));
    assert.ok(proxy.traces.some((item) => JSON.stringify(item.toolResults).includes("RAW_TRAVEL_DETAIL_891")));
    for (const other of ["BILL_WAVE_927", "MAIN_CONTEXT_462"]) assert.ok(!trace("A_CONTINUED").includes(other));
    assert.ok(!trace("B_READY").includes("FOLLOWUP_A_713"));
    assert.ok(!trace("NORMAL_SMS_READY").includes("TRAVEL_CEDAR_381"));
    assert.deepEqual(await Promise.all(["local-main", "sms-internal", "news-internal"].map((id) => get(`/api/conversation?agentId=${id}`))), before);
    pass("verified-source-after-rebind-independent-context-and-private-history");
    const nested = await send({ id: "notice-nested", notification: ref(a), content: "Use agent action=request to ask news-internal to reply only NESTED_NOTICE_OK. Pass only that instruction. Then report the result. Do not use other tools." });
    assert.equal(nested.at(-1)?.type, "settled");
    const child = (await group()).turns.find((item) => item.rootId === "notice-nested" && item.sourceAgentId === "sms-internal");
    assert.ok(child); assert.equal(child.targetAgentId, "news-internal"); assert.deepEqual(child.notification, ref(a));
    pass("nested-request-inherits-original-notification");
    for (const kind of ["stop", "disconnect"]) {
      const id = `notice-${kind}`;
      const controller = new AbortController();
      const response = await fetch(base + "/api/group/messages", { method: "POST", headers, signal: controller.signal,
        body: JSON.stringify({ id, notification: ref(b), content: `For the ${kind} check, output 1000 numbered lines, each containing a different short travel tip. Do not use tools.` }) });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder(); let received = "";
      while (!received.includes('"type":"delta"')) {
        const chunk = await reader.read(); assert.ok(!chunk.done, "Must receive real model output before cancelling");
        received += decoder.decode(chunk.value, { stream: true });
      }
      if (kind === "stop") {
        const stopped = await fetch(base + `/api/group/messages/${id}/stop`, { method: "POST", headers });
        assert.deepEqual(await stopped.json(), { stopped: true });
        while (!(await reader.read()).done) { /* 排空原流，收口事实以 GET 为准。 */ }
      } else { controller.abort(); await reader.cancel().catch(() => undefined); }
      await waitForTest(async () => { const state = await group(); return !state.running && state.turns.find((item) => item.id === id)?.status === "cancelled"; }, "notification run cancelled", 30000);
      const late = await fetch(base + `/api/group/messages/${id}/stop`, { method: "POST", headers });
      assert.deepEqual(await late.json(), { stopped: false });
    }
    pass("notification-stop-disconnect-and-late-stop");
    const saved = await group(); await stop(); await start(); assert.deepEqual(await group(), saved);
    const duplicate = await send({ id: "notice-a-first", content: "Must not replay", notification: ref(a) });
    assert.equal(duplicate.at(-1)?.code, "BUSY");
    const spoof = await fetch(base + "/api/group/messages", { method: "POST", headers, body: JSON.stringify({ id: "spoof", content: "No", notification: ref(a), targetAgentId: "local-main" }) });
    assert.equal(spoof.status, 400);
    const reset = await fetch(base + "/api/agents/local-main/reset", { method: "POST", headers, body: "{}" }); assert.equal(reset.status, 200);
    const stale = await send({ id: "stale-notice", content: "Do not fallback", notification: ref(a) });
    assert.equal(stale.at(-1)?.code, "NOT_FOUND"); assert.ok(!(await group()).turns.some((item) => item.id === "stale-notice"));
    pass("restart-replay-protection-spoof-and-stale-source");
  } catch (error) {
    process.stderr.write(redactApiKey(error instanceof Error ? error.message : "Notification live failed", model.apiKey) + "\n"); process.exitCode = 1;
  } finally {
    await stop(); await proxy.close();
    if (options.keepArtifacts) {
      await writeFile(join(root, "summary.json"), redactApiKey(JSON.stringify({ results, externalRequests: proxy.traces.length, traces: proxy.traces }, null, 2), model.apiKey));
      process.stdout.write(`Evidence: ${root}\n`);
    } else await rm(root, { recursive: true, force: true });
  }
}
const parsed = parseLiveOptions(process.argv.slice(2));
if (parsed.kind === "ok") await execute(parsed.options);
else if (parsed.kind === "help") process.stdout.write(parsed.help);
else { process.stderr.write(parsed.message + "\n"); process.exitCode = 1; }
