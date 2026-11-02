import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { parseLiveOptions } from "./options.js";
import { createTestClient, waitForTest } from "../support/http-client.js";
import { communicationSpacesResponse, discussionHistoryResponse, spaceRequestResponse } from "../../src/http/contracts/space-communication.js";

const execute = async (options: { configPath: string; keepArtifacts: boolean }) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const raw = JSON.parse(await readFile(options.configPath, "utf8"));
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured) throw new Error("Real model configuration is required");
  const root = await mkdtemp(join(tmpdir(), "pi-muse-space-live-"));
  const dataDir = join(root, "data");
  const proxy = await createLiveModel({ baseUrl: model.baseUrl!, apiKey: model.apiKey });
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let baseUrl = "";
  let scenario = "initialization";
  const results: { name: string; passed: boolean; evidence?: unknown }[] = [];
  const hits: { path: string; closed: boolean; finished: boolean }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const fixture = createServer((req, res) => {
    const hit = { path: req.url ?? "", closed: false, finished: false };
    hits.push(hit);
    res.writeHead(200, { "Content-Type": "text/plain" }); res.write("waiting for live cancellation\n");
    const timer = setTimeout(() => { hit.finished = true; res.end("late completion"); }, 55000);
    timers.add(timer);
    res.on("close", () => { hit.closed = true; clearTimeout(timer); timers.delete(timer); });
  });
  const record = (name: string, evidence: unknown = {}) => {
    results.push({ name, passed: true, evidence }); process.stdout.write(`[PASS] ${name}\n`);
  };
  const stop = async () => {
    const old = service; const server = http; service = undefined; http = undefined;
    try { await old?.close(); } finally {
      if (server && "closeAllConnections" in server) server.closeAllConnections();
      if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
  const config = createConfig({
    server: { host: "127.0.0.1", accessKey: "space-live-isolated-access" },
    model: { baseUrl: proxy.baseUrl, id: model.modelId, apiKey: "proxy-placeholder", contextWindow: model.contextWindow, maxTokens: model.maxTokens },
    runtime: { dataDir, runTimeoutMs: 180000, schedulerIntervalMs: 60000, monitorScanIntervalMs: 60000 },
    tools: { presentation: { default: "summary" }, browser: { enabled: false }, web: { allowPrivateTargets: true, timeoutMs: 60000 } },
  });
  const start = async () => {
    service = await createService(config);
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address(); assert.ok(address && typeof address !== "string");
    baseUrl = `http://127.0.0.1:${address.port}`;
  };
  try {
    await start();
    fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");
    const address = fixture.address(); assert.ok(address && typeof address !== "string");
    const fixtureBase = `http://127.0.0.1:${address.port}`;
    const login = await fetch(baseUrl + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "space-live-isolated-access" }) });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    const client = createTestClient(() => baseUrl, token, 190000);
    const request = async (message: string, targetSpaceId = "sms-internal", discussionId?: string, sourceSpaceId = "local-main") => {
      const receipt = spaceRequestResponse.parse(await client.json("/api/space-communication/requests", { sourceSpaceId, targetSpaceId, message, ...(discussionId ? { discussionId } : {}) }));
      assert.equal(receipt.status, "completed");
      assert.equal(receipt.sourceSpaceId, sourceSpaceId);
      assert.equal(receipt.targetSpaceId, targetSpaceId);
      return receipt;
    };
    const history = async (target: string, discussion: string) => discussionHistoryResponse.parse(await client.json(`/api/space-communication/discussions/${target}/${discussion}`));
    const wait = <T>(label: string, check: () => T | Promise<T>) => waitForTest(check, label, 90000);
    const createWorkspace = (id: string) => client.json(`/api/spaces/${id}/instructions`, { instructions: "Handle requests in this space. Do not delegate unless explicitly asked. Return concise answers." }, "PUT");

    scenario = "discovery-and-invalid-input";
    await createWorkspace("comm-worker");
    const listed = communicationSpacesResponse.parse(await client.json("/api/space-communication/spaces"));
    for (const id of ["local-main", "sms-internal", "news-internal", "comm-worker"]) assert.ok(listed.spaces.some((space) => space.id === id));
    assert.equal((await fetch(baseUrl + "/api/space-communication/spaces")).status, 401);
    assert.equal((await client.request("/api/space-communication/requests", { sourceSpaceId: "local-main", targetSpaceId: "missing-space", message: "test" })).status, 404);
    assert.equal((await client.request("/api/space-communication/requests", { sourceSpaceId: "local-main", targetSpaceId: "sms-internal", message: "test", discussionId: "../../escape" })).status, 400);
    assert.ok(!(await client.json("/api/spaces")).spaces.some((space: { id: string }) => space.id === "missing-space"));
    record(scenario);

    scenario = "target-information-and-primary-context-isolation";
    await client.json("/api/features/sms/settings", { enabled: true, batchWindowSeconds: 15 }, "PUT");
    await client.json("/api/features/sms/items", { items: [{ source: "sms", externalId: "comm-live-parcel", content: "合成验收快递，取件码为 COMM_PARCEL_6248。", title: "合成快递短信" }] });
    await client.json("/api/features/sms/settings", { enabled: false, batchWindowSeconds: 15 }, "PUT");
    const mainBefore = await client.history();
    const smsBefore = await service!.conversationHub.findSpace("sms-internal");
    const smsRevision = (await smsBefore!.snapshot()).revision;
    const firstBaseline = proxy.traces.length;
    const first = await request("请用 information 工具查询本空间已接纳的短信，找到合成快递短信并返回取件码。另记住本讨论的临时暗号 DISCUSSION_CEDAR_8731，仅保留在当前讨论，不写入长期记忆、文件或规则，不转交其他空间。");
    assert.match(first.text, /COMM_PARCEL_6248/);
    assert.ok(proxy.traces.slice(firstBaseline).some((trace) => trace.calls.some((call) => call.name === "information")));
    assert.equal((await client.history()).revision, mainBefore.revision);
    assert.equal((await smsBefore!.snapshot()).revision, smsRevision);
    const firstHistory = await history("sms-internal", first.discussionId);
    assert.ok(firstHistory.messages.some((message) => message.role === "user" && message.content.includes("DISCUSSION_CEDAR_8731")));
    record(scenario, { discussionId: first.discussionId });

    scenario = "follow-up-reuses-target-discussion";
    const second = await request("本讨论刚才给你的临时暗号是什么？只回答暗号，不调用工具，不查文件或记忆。", "sms-internal", first.discussionId);
    assert.match(second.text, /DISCUSSION_CEDAR_8731/);
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(first.discussionId, second.discussionId);
    const continued = await history("sms-internal", first.discussionId);
    assert.equal(continued.messages.filter((message) => message.role === "user").length, 2);
    record(scenario);

    scenario = "reverse-and-workspace-to-workspace";
    const reverse = await request("请直接回答 REVERSE_SPACE_OK，不用工具。", "local-main", undefined, "sms-internal");
    assert.match(reverse.text, /REVERSE_SPACE_OK/);
    const ordinary = await request("请直接回答 WORKSPACE_TO_WORKSPACE_OK，不用工具。", "comm-worker");
    assert.match(ordinary.text, /WORKSPACE_TO_WORKSPACE_OK/);
    assert.equal((await client.history()).revision, mainBefore.revision);
    record(scenario);

    scenario = "target-can-request-source-without-notification-deadlock";
    const callbackBaseline = proxy.traces.length;
    const callback = await request('请只调用一次 space 工具，action=request，targetSpaceId=local-main，message="直接回答 CALLBACK_FROM_MAIN_OK，不使用工具，不转交。"。把它实际返回的文本原样回复，不使用其他工具。', "comm-worker");
    assert.match(callback.text, /CALLBACK_FROM_MAIN_OK/);
    const callbackCalls = proxy.traces.slice(callbackBaseline).flatMap((trace) => trace.calls).filter((call) => call.name === "space");
    assert.equal(callbackCalls.length, 1);
    assert.equal((await client.history()).revision, mainBefore.revision);
    record(scenario);

    scenario = "notification-binding-does-not-route-replies";
    await client.json("/api/features/sms/binding", { spaceId: "comm-worker" }, "PUT");
    const workerBefore = await client.history("comm-worker");
    const bound = await request("请直接回答 REPLY_TO_CALLER_OK，不用工具。");
    assert.equal(bound.sourceSessionId, mainBefore.sessionId);
    assert.equal((await client.history()).revision, mainBefore.revision);
    assert.equal((await client.history("comm-worker")).revision, workerBefore.revision);
    record(scenario);

    scenario = "main-model-real-space-tool-roundtrip";
    const baseline = proxy.traces.length;
    const events = await client.run('这是隔离验收。请只用一次 space 工具，action=request，targetSpaceId=sms-internal，message="请用 information 工具查本空间合成快递短信，返回取件码。不要转交其他空间。"。等待实际结果，再简短告诉我取件码。不要自行读取短信或使用其他工具。');
    assert.equal(events.at(-1)?.type, "RUN_FINISHED");
    const rows = proxy.traces.slice(baseline);
    const calls = rows.flatMap((trace) => trace.calls).filter((call) => call.name === "space");
    assert.equal(calls.length, 1);
    assert.ok(rows.some((trace) => trace.calls.some((call) => call.name === "information")));
    const mainHistory = await client.history();
    assert.ok(mainHistory.messages.some((message: { role: string; content?: string }) => message.role === "assistant" && message.content?.includes("COMM_PARCEL_6248")));
    assert.equal((await smsBefore!.snapshot()).revision, smsRevision);
    record(scenario, { spaceCalls: calls.length, externalRequests: rows.length });

    scenario = "cross-space-approval-returns-to-caller-and-denial-writes-nothing";
    const writing = await client.startRun('请只调用一次 space，action=request，targetSpaceId=comm-worker，message="请用 write 工具新建 approval-check.md，完整内容为 SPACE_APPROVAL_CHECK。不要自行批准、不要改用其他工具或委托。等待用户决定后如实返回结果。"。你自己不要写文件，也不要在拒绝后重试。');
    const approval = await wait("cross-space file approval", async () => (await client.pending()).find((item: { runId?: string | null }) => item.runId === writing.runId));
    assert.equal(approval.spaceId, "local-main");
    assert.equal(approval.workspaceSpaceId, "comm-worker");
    assert.equal(approval.preview.ownerSpaceId, "comm-worker");
    assert.equal(approval.preview.path, "approval-check.md");
    assert.equal(approval.preview.before, "");
    assert.equal(approval.preview.after, "SPACE_APPROVAL_CHECK");
    assert.equal((await client.decideApproval(approval.id, "deny")).status, 200);
    assert.equal((await writing.done).at(-1)?.type, "RUN_FINISHED");
    await assert.rejects(readFile(join(dataDir, "workspace", "threads", "comm-worker", "approval-check.md")), { code: "ENOENT" });
    await assert.rejects(readFile(join(dataDir, "workspace", "threads", "local-main", "approval-check.md")), { code: "ENOENT" });
    record(scenario, { ownerSpaceId: approval.preview.ownerSpaceId });

    scenario = "target-skill-catalog-does-not-use-approval-owner-switches";
    const skill = (await service!.skills.describeAuthoring("local-main")).skills.find((item) => item.enabled);
    assert.ok(skill, "Expected an enabled built-in skill for the isolated catalog check");
    await service!.skills.updateSpaceOverrides("comm-worker", { [skill.name]: false });
    const catalogBaseline = proxy.traces.length;
    await request("请只调用一次 skills 工具，action=list，然后简短回复已查询。不要使用其他工具。", "comm-worker");
    const catalogRows = proxy.traces.slice(catalogBaseline);
    assert.ok(catalogRows.some((trace) => trace.calls.some((call) => call.name === "skills")));
    const catalogs = catalogRows.flatMap((trace) => trace.toolResults).flatMap((text) => {
      try { const value = JSON.parse(text); return Array.isArray(value.skills) ? [value] : []; } catch { return []; }
    });
    assert.ok(catalogs.some((catalog) => catalog.skills.some((item: { name: string; enabled: boolean }) => item.name === skill.name && !item.enabled)));
    assert.equal((await service!.skills.describeAuthoring("local-main")).skills.find((item) => item.name === skill.name)!.enabled, true);
    record(scenario, { skill: skill.name });

    scenario = "restart-preserves-discussion";
    await stop(); await start();
    const resumed = await request("只根据本讨论历史回答临时暗号，不调用工具。", "sms-internal", first.discussionId);
    assert.match(resumed.text, /DISCUSSION_CEDAR_8731/);
    record(scenario);

    const slowPrompt = (path: string) => `请只调用一次 web_fetch 读取 ${fixtureBase}/${path}，等待工具完成再回答，不委托、不使用其他工具。`;
    scenario = "busy-and-http-disconnect-cancel";
    const slowDiscussion = await request("请直接回答 READY，不调用工具。", "comm-worker");
    const controller = new AbortController();
    const pending = fetch(baseUrl + "/api/space-communication/requests", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ sourceSpaceId: "local-main", targetSpaceId: "comm-worker", discussionId: slowDiscussion.discussionId, message: slowPrompt("disconnect") }),
    });
    void pending.catch(() => undefined);
    await wait("real slow HTTP call", () => hits.some((hit) => hit.path === "/disconnect"));
    assert.equal((await client.request("/api/space-communication/requests", { sourceSpaceId: "local-main", targetSpaceId: "comm-worker", discussionId: slowDiscussion.discussionId, message: "do not run concurrently" })).status, 409);
    assert.equal((await client.request(`/api/space-communication/discussions/comm-worker/${slowDiscussion.discussionId}`)).status, 409);
    controller.abort(); await assert.rejects(pending);
    await wait("fixture disconnect", () => hits.some((hit) => hit.path === "/disconnect" && hit.closed && !hit.finished));
    await wait("discussion released", async () => (await client.request(`/api/space-communication/discussions/comm-worker/${slowDiscussion.discussionId}`)).status === 200);
    record(scenario);

    scenario = "parent-stop-propagates-to-space-request";
    const parent = await client.startRun(`请只调用一次 space，action=request，targetSpaceId=comm-worker，message=${JSON.stringify(slowPrompt("parent-stop"))}。不要自行抓网页，不用其他工具。`);
    await wait("nested real HTTP call", () => hits.some((hit) => hit.path === "/parent-stop"));
    const stopped = await client.json("/api/conversation/stop", { spaceId: "local-main", runId: parent.runId });
    assert.equal(stopped.stopped, true);
    assert.equal((await parent.done).at(-1)?.type, "RUN_ERROR");
    await wait("nested call cancelled", () => hits.some((hit) => hit.path === "/parent-stop" && hit.closed && !hit.finished));
    record(scenario);

    scenario = "target-reset-cancels-and-clears-discussions";
    const targetPending = client.json("/api/space-communication/requests", { sourceSpaceId: "local-main", targetSpaceId: "comm-worker", message: slowPrompt("target-reset") });
    void targetPending.catch(() => undefined);
    await wait("target reset fixture", () => hits.some((hit) => hit.path === "/target-reset"));
    await client.json("/api/spaces/comm-worker/reset", {});
    assert.equal(spaceRequestResponse.parse(await targetPending).status, "cancelled");
    assert.equal((await client.request(`/api/space-communication/discussions/comm-worker/${slowDiscussion.discussionId}`)).status, 404);
    await assert.rejects(readdir(join(dataDir, "sessions", "comm-worker", "discussions")), { code: "ENOENT" });
    record(scenario);

    scenario = "source-reset-cancels-without-late-reply";
    const sourceBefore = await client.history();
    const sourcePending = client.json("/api/space-communication/requests", { sourceSpaceId: "local-main", targetSpaceId: "comm-worker", message: slowPrompt("source-reset") });
    void sourcePending.catch(() => undefined);
    await wait("source reset fixture", () => hits.some((hit) => hit.path === "/source-reset"));
    await client.json("/api/spaces/local-main/reset", {});
    const cancelled = spaceRequestResponse.parse(await sourcePending);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.sourceSessionId, sourceBefore.sessionId);
    const sourceAfter = await client.history();
    assert.notEqual(sourceAfter.sessionId, sourceBefore.sessionId);
    assert.equal(sourceAfter.messages.length, 0);
    assert.ok((await history("comm-worker", cancelled.discussionId)).messages.length > 0);
    record(scenario);

    scenario = "target-delete-cancels-without-resurrection";
    await createWorkspace("comm-delete");
    const deletedPending = client.json("/api/space-communication/requests", { sourceSpaceId: "local-main", targetSpaceId: "comm-delete", message: slowPrompt("target-delete") });
    void deletedPending.catch(() => undefined);
    await wait("target delete fixture", () => hits.some((hit) => hit.path === "/target-delete"));
    await client.json("/api/spaces/comm-delete", undefined, "DELETE");
    assert.equal(spaceRequestResponse.parse(await deletedPending).status, "cancelled");
    await assert.rejects(readdir(join(dataDir, "sessions", "comm-delete")), { code: "ENOENT" });
    record(scenario);

    scenario = "service-close-cancels-inflight-request";
    const closePending = client.json("/api/space-communication/requests", { sourceSpaceId: "local-main", targetSpaceId: "comm-worker", message: slowPrompt("service-close") });
    void closePending.catch(() => undefined);
    await wait("service close fixture", () => hits.some((hit) => hit.path === "/service-close"));
    await service!.close();
    assert.equal(spaceRequestResponse.parse(await closePending).status, "cancelled");
    await wait("all cancelled HTTP sockets close", () => hits.every((hit) => hit.closed && !hit.finished));
    record(scenario);
  } catch (error) {
    const message = redactApiKey(error instanceof Error ? error.message : "Live scenario failed", model.apiKey);
    results.push({ name: scenario, passed: false, evidence: { error: message } });
    process.stderr.write(`[FAIL] ${scenario}: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await stop();
    for (const timer of timers) clearTimeout(timer);
    fixture.closeAllConnections();
    if (fixture.listening) await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await proxy.close();
    if (options.keepArtifacts) {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "summary.json"), redactApiKey(JSON.stringify({ results, externalRequests: proxy.traces.length, traces: proxy.traces, hits }, null, 2), model.apiKey));
      process.stdout.write(`Evidence: ${root}\n`);
    } else await rm(root, { recursive: true, force: true });
    process.stdout.write(`${results.filter((result) => result.passed).length}/${results.length} scenarios passed\n`);
  }
};

const parsed = parseLiveOptions(process.argv.slice(2));
if (parsed.kind === "help") process.stdout.write(parsed.help.replace("pnpm test:live", "node --import tsx tests/live/space-communication.ts"));
else if (parsed.kind === "error") { process.stderr.write(parsed.message + "\n"); process.exitCode = 1; }
else await execute(parsed.options);
