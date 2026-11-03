import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { parseLiveOptions } from "./options.js";
import { conversationResponse } from "../../src/http/contracts/responses.js";

type History = ReturnType<typeof conversationResponse.parse>;
type RunPublication = {
  notificationId?: string;
  itemIds?: string[];
  status?: string;
  error?: string;
  receipt?: { notificationId: string; sessionId: string; messageId: string };
};
type InformationRun = {
  id: string;
  itemIds: string[];
  status: "running" | "completed" | "failed" | "cancelled";
  model?: { status?: string; error?: string };
  decisions?: Array<{ itemId: string; decision: "silent" | "notify"; reason: string }>;
  publications?: RunPublication[];
};
type InformationRunDetail = { run: InformationRun; items: Array<{ id: string; status: string; content: string }> };
type CallTrace = {
  index: number;
  users: string[];
  toolNames: string[];
  toolResults: string[];
  calls: { name: string; arguments: string }[];
};
type ApiResult = { status: number; body: unknown; text: string };

const waitFor = async <T>(
  label: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 180_000,
) => {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const sseFinished = (text: string) =>
  text.split("\n").some((line) => {
    if (!line.startsWith("data: ")) return false;
    try {
      return (JSON.parse(line.slice(6)) as { type?: string }).type === "RUN_FINISHED";
    } catch {
      return false;
    }
  });
const sseError = (text: string) =>
  text.split("\n").some((line) => {
    if (!line.startsWith("data: ")) return false;
    try {
      return (JSON.parse(line.slice(6)) as { type?: string }).type === "RUN_ERROR";
    } catch {
      return false;
    }
  });
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionsRunId = (text: string, runId: string) =>
  new RegExp(String.raw`"runId"\s*:\s*"${escapeRegExp(runId)}"`).test(text);

const execute = async (options: { configPath: string; keepArtifacts: boolean }) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");

  // 只读取显式配置的 model 段；key 只进入透明代理内存。
  const raw = JSON.parse(await readFile(options.configPath, "utf8")) as { model?: unknown };
  const model = createConfig({ model: raw.model });
  if (!model.configured || !model.baseUrl || !model.modelId) throw new Error("Model configuration is required");

  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let root: string | undefined;
  let serviceVersion: unknown;
  let failure: string | undefined;
  const evidence: Array<{ name: string; passed: boolean; detail: Record<string, unknown> }> = [];

  try {
    root = await mkdtemp(join(tmpdir(), "pi-muse-information-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl, apiKey: model.apiKey });
    const config = createConfig({
      server: { host: "127.0.0.1", accessKey: "live-information-key" },
      model: {
        baseUrl: proxy.baseUrl,
        id: model.modelId,
        apiKey: "proxy-placeholder",
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
      runtime: {
        dataDir,
        runTimeoutMs: 180_000,
        schedulerIntervalMs: 200,
        monitorScanIntervalMs: 60_000,
      },
      tools: { presentation: { default: "summary" }, web: { enabled: false }, browser: { enabled: false } },
    });

    service = await createService(config);
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(baseUrl + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessKey: "live-information-key" }),
    });
    assert.equal(login.status, 200);
    let token = ((await login.json()) as { token: string }).token;

    const api = async (path: string, init: RequestInit = {}, timeoutMs = 180_000): Promise<ApiResult> => {
      const response = await fetch(baseUrl + path, {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: response.status, body, text };
    };
    const expectApi = async (label: string, path: string, expected: number, init?: RequestInit) => {
      const result = await api(path, init);
      assert.equal(result.status, expected, `${label}: expected ${expected}, got ${result.status}`);
      return result;
    };
    serviceVersion = ((await expectApi("health", "/api/health", 200)).body as { serviceVersion?: unknown }).serviceVersion;
    const history = async (agentId: string) =>
      conversationResponse.parse((await expectApi("history", `/api/conversation?agentId=${agentId}`, 200)).body);
    const setupAgent = async (
      agentId: string,
      settings: { enabled: boolean; batchWindowSeconds: number },
      instructions: string,
    ) => {
      await expectApi("instructions", `/api/agents/${agentId}/instructions`, 200, {
        method: "PUT", body: JSON.stringify({ instructions }),
      });
      await expectApi("settings", `/api/agents/${agentId}/information/settings`, 200, {
        method: "PUT", body: JSON.stringify(settings),
      });
    };
    const ingest = async (agentId: string, items: Array<{ source: string; externalId: string; content: string; title?: string; receivedAt?: string }>) => {
      const result = await expectApi("ingest", `/api/agents/${agentId}/information/items`, 200, {
        method: "POST", body: JSON.stringify({ items }),
      });
      return (result.body as { items: Array<{ id: string; content: string; status: string }> }).items;
    };
    const runDetail = async (agentId: string, runId: string) =>
      (await expectApi("run detail", `/api/agents/${agentId}/information/runs/${runId}`, 200)).body as InformationRunDetail;
    const latestRun = async (agentId: string, status?: string): Promise<InformationRun | undefined> => {
      const query = status ? `?status=${status}` : "";
      const page = (await expectApi("runs", `/api/agents/${agentId}/information/runs${query}`, 200)).body as { runs: InformationRun[] };
      return page.runs[0];
    };
    const runInformation = (agentId: string) =>
      api(`/api/agents/${agentId}/information/runs`, { method: "POST", body: "{}" });
    const startChat = async (agentId: string, prompt: string) => {
      const before = await history(agentId);
      const result = await api("/api/conversation/run", {
        method: "POST",
        body: JSON.stringify({
          agentId,
          runId: `live-info-chat-${randomUUID()}`,
          expectedRevision: before.revision,
          message: { id: `live-info-user-${randomUUID()}`, content: prompt },
        }),
      }, 300_000);
      assert.equal(result.status, 200, `chat HTTP ${result.status}`);
      return result.text;
    };
    const backgroundTraces = (runId: string) =>
      proxy!.traces.filter((trace) => trace.toolNames.length === 1 &&
        trace.toolNames[0] === "submit_information_result" &&
        trace.users.some((user) => mentionsRunId(user, runId)));

    process.stdout.write("真实信息后台验收已授权：将产生外部模型费用；实例、DATA_DIR 与代理均为临时隔离资源。\n");
    const record = (name: string, detail: Record<string, unknown>) => {
      evidence.push({ name, passed: true, detail });
      process.stdout.write(`[PASS] ${name}\n`);
    };

      const mainAgent = "live-information-main";
      const policy = [
        "Information processing policy for this test agent:",
        "- Notify only for URGENT items that require the user to act now.",
        "- Prefer one aggregated notification when several urgent items belong to the same batch.",
        "- Keep routine logs and unchanged status reports silent.",
      ].join("\n");
      await setupAgent(mainAgent, { enabled: true, batchWindowSeconds: 3600 }, policy);
      assert.deepEqual(
        (await expectApi("default readback", `/api/agents/${mainAgent}/information/settings`, 200)).body,
        { enabled: true, batchWindowSeconds: 3600 },
      );
      await expectApi("notes", `/api/agents/${mainAgent}/information/preferences`, 200, {
        method: "PUT", body: JSON.stringify({ notes: "Prefer concise notifications with source and action." }),
      });

      const mixedInputs = [
        { source: "live-feed", externalId: "mixed-urgent-1", content: "URGENT: live test certificate expires in one hour and must be renewed.", title: "Certificate expiry", receivedAt: "2026-10-29T01:00:00.000Z" },
        { source: "live-log", externalId: "mixed-routine", content: "ROUTINE: daily disk usage remained stable; no action is required." },
        { source: "live-feed", externalId: "mixed-urgent-2", content: "URGENT: live test dependency has a confirmed vulnerability and needs an upgrade now.", title: "Dependency upgrade" },
      ];
      const mixedItems = await ingest(mainAgent, mixedInputs);
      const repeat = await ingest(mainAgent, [mixedInputs[0]!]);
      assert.equal(repeat[0]?.id, mixedItems[0]?.id);
      const conflict = await api(`/api/agents/${mainAgent}/information/items`, {
        method: "POST", body: JSON.stringify({ items: [{ ...mixedInputs[0]!, content: "different raw content" }] }),
      });
      assert.equal(conflict.status, 409);

      const baselineHistory = await history(mainAgent);
      const baselineTraces = proxy.traces.length;
      const mixedRunResult = await runInformation(mainAgent);
      assert.equal(mixedRunResult.status, 200);
      const mixedRun = mixedRunResult.body as InformationRunDetail;
      assert.equal(mixedRun.run.status, "completed");
      assert.equal(mixedRun.run.model?.status, "succeeded");
      const decisions = new Map(mixedRun.run.decisions?.map((decision) => [decision.itemId, decision.decision]));
      assert.equal(decisions.get(mixedItems[0]!.id), "notify");
      assert.equal(decisions.get(mixedItems[1]!.id), "silent");
      assert.equal(decisions.get(mixedItems[2]!.id), "notify");
      assert.equal(mixedRun.run.publications?.length, 1, "policy asks the model to aggregate urgent items");
      const publication = mixedRun.run.publications?.[0];
      assert.equal(publication?.status, "published");
      assert.deepEqual(new Set(publication?.itemIds), new Set([mixedItems[0]!.id, mixedItems[2]!.id]));
      assert.ok(publication?.receipt?.sessionId && publication.receipt.messageId);
      const notifiedHistory = await history(mainAgent);
      const notification = notifiedHistory.messages.find((message) => message.id === publication?.receipt?.messageId);
      assert.equal(notification?.metadata?.source, "notification");
      assert.equal(notification?.metadata?.notificationId, publication?.notificationId);
      const mixedTraces = proxy.traces.slice(baselineTraces).filter((trace) => trace.toolNames.includes("submit_information_result"));
      assert.ok(mixedTraces.length >= 2);
      assert.ok(mixedTraces[0]?.toolNames.length === 1 && mixedTraces[0].toolNames[0] === "submit_information_result");
      assert.ok(mixedTraces.some((trace) => trace.calls.some((call) => call.name === "submit_information_result")));
      assert.ok(mixedTraces.some((trace) => trace.toolResults.some((result) => result.includes("Accepted information decisions."))));
      record("mixed-batch-and-publication", {
        runId: mixedRun.run.id,
        decisions: mixedRun.run.decisions?.length,
        notificationId: publication?.notificationId,
        sessionId: publication?.receipt?.sessionId,
        messageId: publication?.receipt?.messageId,
        modelRequests: mixedTraces.length,
      });

      const silentBefore = await history(mainAgent);
      const silentTracesBefore = proxy.traces.length;
      const silentItems = await ingest(mainAgent, [
        { source: "live-log", externalId: "silent-1", content: "ROUTINE: cleanup job completed with no changes." },
        { source: "live-log", externalId: "silent-2", content: "ROUTINE: cache hit ratio stayed in the normal range." },
      ]);
      const silentRunResult = await runInformation(mainAgent);
      assert.equal(silentRunResult.status, 200);
      const silentRun = silentRunResult.body as InformationRunDetail;
      assert.deepEqual(silentRun.run.decisions?.map((decision) => decision.decision), ["silent", "silent"]);
      assert.deepEqual(silentRun.run.publications, []);
      const silentAfter = await history(mainAgent);
      assert.equal(silentAfter.revision, silentBefore.revision);
      assert.equal(silentAfter.messages.length, silentBefore.messages.length);
      const silentTraces = proxy.traces.slice(silentTracesBefore).filter((trace) => trace.toolNames.includes("submit_information_result"));
      assert.ok(silentTraces.some((trace) => trace.toolResults.some((result) => result.includes("Accepted information decisions."))));
      record("all-silent-no-chat-write", { runId: silentRun.run.id, items: silentItems.length, revision: silentAfter.revision });

      const feedbackMessageId = publication!.receipt!.messageId;
      const feedbackSessionId = publication!.receipt!.sessionId;
      const addComment = await expectApi("feedback comment", `/api/agents/${mainAgent}/messages/${feedbackMessageId}/feedback/comments`, 200, {
        method: "POST", body: JSON.stringify({ sessionId: feedbackSessionId, text: "stale feedback wording" }),
      });
      const comments = (addComment.body as { comments: Array<{ id: string }> }).comments;
      await expectApi("edit feedback comment", `/api/agents/${mainAgent}/messages/${feedbackMessageId}/feedback/comments/${comments.at(-1)!.id}`, 200, {
        method: "PATCH", body: JSON.stringify({ sessionId: feedbackSessionId, text: "latest live feedback: keep notifications concise" }),
      });
      await expectApi("feedback reaction", `/api/agents/${mainAgent}/messages/${feedbackMessageId}/feedback/reaction`, 200, {
        method: "PUT", body: JSON.stringify({ sessionId: feedbackSessionId, reaction: "like" }),
      });
      const preferences = (await expectApi("preferences", `/api/agents/${mainAgent}/information/preferences`, 200)).body as {
        notes: string;
        feedbackExamples: Array<{ comments: string[]; reaction: string | null; items: Array<{ source: string; content: string }> }>;
      };
      assert.equal(preferences.notes, "Prefer concise notifications with source and action.");
      assert.equal(preferences.feedbackExamples[0]?.reaction, "like");
      assert.deepEqual(preferences.feedbackExamples[0]?.comments, ["latest live feedback: keep notifications concise"]);
      assert.ok(preferences.feedbackExamples[0]?.items.some((item) => item.source === "live-feed"));

      const feedbackTracesBefore = proxy.traces.length;
      const feedbackItems = await ingest(mainAgent, [
        { source: "live-feed", externalId: "feedback-projection", content: "URGENT: The customer appointment is tomorrow morning and must be confirmed today before 5 PM." },
      ]);
      const feedbackRunResult = await runInformation(mainAgent);
      assert.equal(feedbackRunResult.status, 200);
      const feedbackRun = feedbackRunResult.body as InformationRunDetail;
      const feedbackTraces = proxy.traces.slice(feedbackTracesBefore).filter((trace) => backgroundTraces(feedbackRun.run.id).includes(trace));
      assert.ok(feedbackTraces.length >= 2);
      const modelInput = feedbackTraces.map((trace) => trace.users.join("\n")).join("\n");
      assert.ok(modelInput.includes("latest live feedback: keep notifications concise"));
      assert.ok(modelInput.includes("Prefer concise notifications with source and action."));
      assert.ok(modelInput.includes("Certificate expiry"));
      assert.ok(!modelInput.includes("stale feedback wording"));
      record("current-feedback-projection", { runId: feedbackRun.run.id, modelRequests: feedbackTraces.length, feedbackItemId: feedbackItems[0]?.id });

      const otherAgent = "live-information-other";
      await setupAgent(otherAgent, { enabled: true, batchWindowSeconds: 3600 }, "Keep information notifications concise.");
      const otherItems = await ingest(otherAgent, [mixedInputs[0]!]);
      assert.notEqual(otherItems[0]?.id, mixedItems[0]?.id);
      assert.equal((await latestRun(otherAgent)), undefined);
      const otherRun = await runInformation(otherAgent);
      assert.equal(otherRun.status, 200);
      const mainAfterOther = await latestRun(mainAgent);
      assert.notEqual(mainAfterOther?.id, (otherRun.body as InformationRunDetail).run.id);
      record("cross-agent-isolation", { mainItem: mixedItems[0]?.id, otherItem: otherItems[0]?.id });

      const chatTraceBefore = proxy.traces.length;
      const chatText = await startChat(mainAgent, "请调用 information 工具查询当前智能体的信息处理概览，然后用一句话汇报。不要读取其他智能体。");
      assert.ok(sseFinished(chatText));
      const chatTraces = proxy.traces.slice(chatTraceBefore);
      assert.ok(chatTraces.length > 0);
      assert.ok(chatTraces.every((trace) => trace.systemMarkers.informationBackground));
      const informationCall = chatTraces.flatMap((trace) => trace.calls).find((call) => call.name === "information");
      assert.ok(informationCall, "ordinary chat must actually call information");
      const informationArgs = JSON.parse(informationCall!.arguments) as { action?: string; agentId?: string };
      assert.equal(informationArgs.action, "overview");
      assert.equal(informationArgs.agentId, undefined);
      assert.ok(chatTraces.some((trace) => trace.toolResults.some((result) => result.includes(mixedRun.run.id))));
      const wrappedSources = chatTraces
        .flatMap((trace) => trace.assistantContexts)
        .filter((context) => context.informationNotification);
      const publishedSources = new Map(
        [mixedRun, feedbackRun].flatMap((run) =>
          (run.run.publications ?? [])
            .filter((entry) => entry.status === "published" && entry.notificationId)
            .map((entry) => [entry.notificationId!, run.run.id] as const),
        ),
      );
      const targetSources = wrappedSources.filter((source) => source.notificationId === publication?.notificationId);
      assert.ok(targetSources.length > 0, "the mixed-run notification must remain visible with its server source");
      for (const source of targetSources) assert.equal(source.informationRunId, mixedRun.run.id);
      for (const source of wrappedSources) {
        assert.ok(source.notificationId && publishedSources.has(source.notificationId));
        assert.equal(source.informationRunId, publishedSources.get(source.notificationId));
      }
      const itemCountAfterChat = ((await expectApi("items after chat", `/api/agents/${mainAgent}/information/items?limit=100`, 200)).body as { items: unknown[] }).items.length;
      assert.equal(itemCountAfterChat, mixedItems.length + silentItems.length + feedbackItems.length);
      record("ordinary-chat-readonly-tool-and-source", {
        toolArguments: informationArgs,
        referencedRun: mixedRun.run.id,
        notificationId: publication?.notificationId,
        sourceNotifications: [...new Set(wrappedSources.map((source) => source.notificationId))],
      });

      const autoAgent = "live-information-auto";
      await setupAgent(autoAgent, { enabled: true, batchWindowSeconds: 0 }, policy);
      const autoTracesBefore = proxy.traces.length;
      const autoItems = await ingest(autoAgent, [
        { source: "live-feed", externalId: "automatic", content: "URGENT: The staging server certificate expires in 30 minutes and must be renewed now." },
      ]);
      const automatic = await waitFor("automatic information run", async () => {
        const run = await latestRun(autoAgent);
        if (!run || !["completed", "failed", "cancelled"].includes(run.status)) return undefined;
        return run.publications?.some((publication) => publication.status === "pending") ? undefined : run;
      });
      assert.equal(automatic.status, "completed", `automatic run ${automatic.id} ended ${automatic.status}: ${automatic.model?.error ?? "no model error"}`);
      assert.equal(automatic.model?.status, "succeeded", `automatic run ${automatic.id} model status ${automatic.model?.status ?? "missing"}: ${automatic.model?.error ?? "no model error"}`);
      assert.equal(automatic.decisions?.[0]?.decision, "notify", `automatic run ${automatic.id} decisions ${JSON.stringify(automatic.decisions)}`);
      assert.equal(automatic.publications?.[0]?.status, "published", `automatic run ${automatic.id} publications ${JSON.stringify(automatic.publications)}`);
      const autoTraces = proxy.traces.slice(autoTracesBefore).filter((trace) => backgroundTraces(automatic.id).includes(trace));
      assert.ok(autoTraces.some((trace) => trace.calls.some((call) => call.name === "submit_information_result")));
      record("automatic-scheduler", { runId: automatic.id, itemId: autoItems[0]?.id, modelRequests: autoTraces.length });

      const waitQueued = async (agentId: string) => {
        const run = await waitFor("queued publication", async () => {
          const current = await latestRun(agentId);
          if (!current) return undefined;
          if (current.status === "failed" || current.status === "cancelled") {
            throw new Error(`queued publication run ${current.id} ended ${current.status}: ${current.model?.error ?? "no model error"}`);
          }
          if (current.status !== "completed") return undefined;
          if (!current.publications?.length) {
            throw new Error(`queued publication run ${current.id} completed without publications; decisions=${JSON.stringify(current.decisions)}`);
          }
          if (!current.publications.some((publication) => publication.status === "pending")) {
            throw new Error(`queued publication run ${current.id} completed without a pending publication; publications=${JSON.stringify(current.publications)}`);
          }
          return current;
        });
        assert.equal(run.model?.status, "succeeded");
        return run;
      };
      const startBusyChat = (agentId: string, marker: string) => {
        const prompt = `${marker} Please write a detailed, well-organized 2500-word technical essay about reliable personal server architecture. Do not call any tool.`;
        const text = startChat(agentId, prompt);
        return {
          text,
          started: waitFor("busy chat model request", () => Promise.resolve(proxy!.traces.some((trace) => trace.users.some((user) => user.includes(marker))))),
        };
      };

      const disableAgent = "live-information-disable";
      await setupAgent(disableAgent, { enabled: true, batchWindowSeconds: 3600 }, policy);
      const disableChat = startBusyChat(disableAgent, "LIVE_INFORMATION_DISABLE_BUSY");
      await disableChat.started;
      await ingest(disableAgent, [{ source: "live-feed", externalId: "disable", content: "URGENT: The production certificate expires in 30 minutes and must be renewed now." }]);
      const disableRunPromise = runInformation(disableAgent);
      const queuedDisable = await waitQueued(disableAgent);
      await expectApi("disable", `/api/agents/${disableAgent}/information/settings`, 200, {
        method: "PUT", body: JSON.stringify({ enabled: false, batchWindowSeconds: 3600 }),
      });
      const disableRun = (await disableRunPromise).body as InformationRunDetail;
      assert.equal(disableRun.run.id, queuedDisable.id);
      assert.equal(disableRun.run.publications?.[0]?.status, "failed");
      assert.ok(sseFinished(await disableChat.text));
      assert.equal((await history(disableAgent)).messages.filter((message) => message.metadata?.source === "notification").length, 0);
      const disabledIngest = await api(`/api/agents/${disableAgent}/information/items`, {
        method: "POST", body: JSON.stringify({ items: [{ source: "live-feed", externalId: "after-disable", content: "must reject" }] }),
      });
      assert.equal(disabledIngest.status, 409);
      record("disable-cancels-queued-notification", { runId: queuedDisable.id });

      const resetAgent = "live-information-reset";
      await setupAgent(resetAgent, { enabled: true, batchWindowSeconds: 3600 }, policy);
      await expectApi("reset notes", `/api/agents/${resetAgent}/information/preferences`, 200, {
        method: "PUT", body: JSON.stringify({ notes: "reset preserves these notes" }),
      });
      const resetChat = startBusyChat(resetAgent, "LIVE_INFORMATION_RESET_BUSY");
      await resetChat.started;
      await ingest(resetAgent, [{ source: "live-feed", externalId: "reset", content: "URGENT: The customer appointment is tomorrow at 9 AM and must be confirmed today." }]);
      const resetRunPromise = runInformation(resetAgent);
      const queuedReset = await waitQueued(resetAgent);
      await expectApi("reset", `/api/agents/${resetAgent}/reset`, 200, { method: "POST", body: "{}" });
      const resetRun = (await resetRunPromise).body as InformationRunDetail;
      assert.equal(resetRun.run.id, queuedReset.id);
      assert.equal(resetRun.run.publications?.[0]?.status, "failed");
      assert.match(await resetChat.text, /RUN_ERROR/);
      const resetHistory = await history(resetAgent);
      assert.deepEqual(resetHistory.messages, []);
      assert.deepEqual((await expectApi("reset settings", `/api/agents/${resetAgent}/information/settings`, 200)).body, { enabled: true, batchWindowSeconds: 3600 });
      assert.equal(((await expectApi("reset preferences", `/api/agents/${resetAgent}/information/preferences`, 200)).body as { notes: string }).notes, "reset preserves these notes");
      record("reset-cancels-and-preserves-information", { runId: queuedReset.id });

      const deleteAgent = "live-information-delete";
      await setupAgent(deleteAgent, { enabled: true, batchWindowSeconds: 3600 }, policy);
      const deleteChat = startBusyChat(deleteAgent, "LIVE_INFORMATION_DELETE_BUSY");
      await deleteChat.started;
      await ingest(deleteAgent, [{ source: "live-feed", externalId: "delete", content: "URGENT: The payment authorization expires in 30 minutes and requires immediate action." }]);
      const deleteRunPromise = runInformation(deleteAgent);
      const queuedDelete = await waitQueued(deleteAgent);
      await expectApi("delete", `/api/agents/${deleteAgent}`, 200, { method: "DELETE" });
      const deletedRunResult = await deleteRunPromise;
      if (deletedRunResult.status === 200) {
        const deletedRun = deletedRunResult.body as InformationRunDetail;
        assert.equal(deletedRun.run.id, queuedDelete.id);
        assert.equal(deletedRun.run.publications?.[0]?.status, "failed");
      } else {
        // pause.stopped 与手动 run 的最终读取之间天然存在微任务竞态；删除已完成时 404 是真实结果。
        assert.equal(deletedRunResult.status, 404);
      }
      assert.match(await deleteChat.text, /RUN_ERROR/);
      assert.equal(existsSync(join(dataDir, "information", `${deleteAgent}.json`)), false);
      record("delete-cancels-and-cascades", { runId: queuedDelete.id });

      const restartAgent = "live-information-restart";
      await setupAgent(restartAgent, { enabled: true, batchWindowSeconds: 3600 }, policy);
      await expectApi("restart notes", `/api/agents/${restartAgent}/information/preferences`, 200, {
        method: "PUT", body: JSON.stringify({ notes: "restart preserves pending input" }),
      });
      const restartItems = await ingest(restartAgent, [
        { source: "live-feed", externalId: "restart-pending", content: "URGENT: this pending fact must survive service restart." },
      ]);
      const traceCountBeforeRestart = proxy!.traces.length;

      const stopService = async () => {
        const currentService = service!;
        const currentHttp = http!;
        service = undefined;
        http = undefined;
        await currentService.close();
        if ("closeAllConnections" in currentHttp) currentHttp.closeAllConnections();
        await new Promise<void>((resolve, reject) => currentHttp.close((error) => error ? reject(error) : resolve()));
      };
      await stopService();
      const restartedService = await createService(config);
      const restartedHttp = serve({ fetch: restartedService.app.fetch, hostname: "127.0.0.1", port: 0 });
      service = restartedService;
      http = restartedHttp;
      if (!restartedHttp.listening) await once(restartedHttp, "listening");
      const newAddress = restartedHttp.address();
      assert.ok(newAddress && typeof newAddress !== "string");
      const restartedBaseUrl = `http://127.0.0.1:${newAddress.port}`;
      const loginAgain = await fetch(restartedBaseUrl + "/api/session", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey: "live-information-key" }),
      });
      assert.equal(loginAgain.status, 200);
      token = ((await loginAgain.json()) as { token: string }).token;
      // api 闭包保留旧端口；重启检查改用新地址的短助手。
      const restartedGet = async (path: string) => {
        const response = await fetch(restartedBaseUrl + path, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(response.status, 200);
        return response.json();
      };
      const restartedSettings = await restartedGet(`/api/agents/${restartAgent}/information/settings`);
      const restartedPrefs = await restartedGet(`/api/agents/${restartAgent}/information/preferences`) as { notes: string };
      const restartedItems = await restartedGet(`/api/agents/${restartAgent}/information/items?limit=100`) as { items: Array<{ id: string; status: string }> };
      assert.deepEqual(restartedSettings, { enabled: true, batchWindowSeconds: 3600 });
      assert.equal(restartedPrefs.notes, "restart preserves pending input");
      assert.deepEqual(restartedItems.items.map((item) => [item.id, item.status]), [[restartItems[0]?.id, "pending"]]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(proxy.traces.length, traceCountBeforeRestart, "restart must not replay pending model work");
      record("restart-persistence", { itemId: restartItems[0]?.id, modelRequestsAfterRestart: proxy.traces.length - traceCountBeforeRestart });

      const submitEvidence = proxy.traces
        .map((trace) => ({
          index: trace.index,
          calls: trace.calls.filter((call) => call.name === "submit_information_result"),
          accepted: trace.toolResults.some((result) => result.includes("Accepted information decisions.")),
        }))
        .filter((trace) => trace.calls.length === 1);
      const acceptedEvidence = proxy.traces.filter((trace) =>
        trace.toolResults.some((result) => result.includes("Accepted information decisions.")));
      assert.ok(acceptedEvidence.length >= 6);
      assert.ok(submitEvidence.length >= acceptedEvidence.length);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    const withCleanupTimeout = async (label: string, work: () => Promise<unknown>) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          work(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out`)), 30_000);
          }),
        ]);
      } catch (error) {
        cleanupFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    };
    if (root && proxy && options.keepArtifacts) {
      const artifactRoot = root;
      const artifactProxy = proxy;
      await withCleanupTimeout("artifact write", async () => {
        const submitEvidence = artifactProxy.traces
          .map((trace) => ({
            index: trace.index,
            calls: trace.calls.filter((call) => call.name === "submit_information_result"),
            accepted: trace.toolResults.some((result) => result.includes("Accepted information decisions.")),
          }))
          .filter((trace) => trace.calls.length === 1);
        const summary = {
          passed: failure === undefined && cleanupFailures.length === 0,
          failure: failure ?? null,
          scenarios: evidence,
          realModelRequests: artifactProxy.traces.length,
          structuredSubmitToolCalls: submitEvidence.length,
          serviceVersion: serviceVersion ?? null,
          cleanupFailures,
        };
        const traces = redactApiKey(JSON.stringify(artifactProxy.traces, null, 2), model.apiKey);
        const report = redactApiKey(JSON.stringify(summary, null, 2), model.apiKey);
        await writeFile(join(artifactRoot, "tool-traces.json"), traces + "\n", { mode: 0o600 });
        await writeFile(join(artifactRoot, "summary.json"), report + "\n", { mode: 0o600 });
        process.stdout.write(`[ARTIFACTS] ${artifactRoot}\n`);
      });
    }
    if (service) await withCleanupTimeout("service close", () => service!.close());
    if (http) await withCleanupTimeout("HTTP close", async () => {
      const currentHttp = http!;
      if ("closeAllConnections" in currentHttp) currentHttp.closeAllConnections();
      await new Promise<void>((resolve) => currentHttp.close(() => resolve()));
    });
    if (proxy) await withCleanupTimeout("model proxy close", () => proxy!.close());
    if (root && !options.keepArtifacts) {
      await withCleanupTimeout("artifact cleanup", () => rm(root!, { recursive: true, force: true }));
    }
    if (cleanupFailures.length) {
      process.exitCode = 1;
      process.stderr.write(`[CLEANUP-FAIL] ${cleanupFailures.join("; ")}\n`);
    }
  }
};

const outcome = parseLiveOptions(process.argv.slice(2));
if (outcome.kind === "help") {
  console.log(outcome.help);
} else if (outcome.kind === "error") {
  console.error(outcome.message);
  process.exitCode = 1;
} else {
  try {
    await execute(outcome.options);
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
