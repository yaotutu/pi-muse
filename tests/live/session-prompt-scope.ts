import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import type { SseEvent } from "../../src/http/contracts/sse-events.js";

type Scenario = "prompt" | "dream";
type Options = { configPath: string; scenario: Scenario };

const identitySentinel = "LIVE_AGENT_PROMPT_IDENTITY_SENTINEL_9d31";
const goalSentinel = "LIVE_AGENT_PROMPT_GOAL_SENTINEL_61af";
const localDreamSentinel = "LIVE_DREAM_LOCAL_FILTER_SENTINEL_74c2";
const globalDreamSentinel = "LIVE_DREAM_GLOBAL_FACT_SENTINEL_28b7";
const pendingDreamSentinel = "LIVE_DREAM_UNCLEAR_FACT_SENTINEL_45e8";

const parseOptions = (argv: readonly string[]) => {
  const values = { configPath: "", scenario: "" };
  let allowLive = false;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!;
    if (seen.has(name)) throw new Error("Duplicate live option");
    seen.add(name);
    if (name === "--allow-live") allowLive = true;
    else if (name === "--config" || name === "--scenario") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
      if (name === "--config") values.configPath = value;
      else values.scenario = value;
    } else throw new Error(`Unknown option: ${name}`);
  }
  if (!allowLive) throw new Error("Refusing model calls without --allow-live");
  if (!values.configPath) throw new Error("Missing --config <path>");
  if (values.scenario !== "prompt" && values.scenario !== "dream")
    throw new Error("Missing or invalid --scenario prompt|dream");
  return { configPath: values.configPath, scenario: values.scenario as Scenario } satisfies Options;
};

const terminalEvent = (events: SseEvent[]) =>
  assert.ok(events.at(-1)?.type === "RUN_FINISHED", "chat run did not finish successfully");

const execute = async ({ configPath, scenario }: Options) => {
  const { createService } = await import("../../src/bootstrap/create-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel } = await import("../support/live-model.js");
  const { createTestClient } = await import("../support/http-client.js");

  const raw = JSON.parse(await readFile(configPath, "utf8")) as { model?: unknown };
  const model = createConfig({ model: raw.model });
  if (!model.configured || !model.baseUrl || !model.modelId)
    throw new Error("Model configuration is required");

  let root: string | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let executionError: unknown;

  try {
    root = await mkdtemp(join(tmpdir(), "pi-muse-agent-prompt-scope-"));
    const dataDir = join(root, "data");
    await mkdir(join(dataDir, "profile"), { recursive: true, mode: 0o700 });
    if (scenario === "prompt")
      await writeFile(join(dataDir, "profile", "USER.md"), identitySentinel, { mode: 0o600 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl, apiKey: model.apiKey });
    const config = createConfig({
      server: { host: "127.0.0.1", accessKey: "live-agent-prompt-scope-access" },
      model: {
        baseUrl: proxy.baseUrl,
        id: model.modelId,
        apiKey: "proxy-placeholder",
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
      runtime: {
        dataDir,
        runTimeoutMs: 300_000,
        schedulerIntervalMs: 300_000,
        monitorScanIntervalMs: 300_000,
      },
      tools: {
        web: { enabled: true },
        weather: { enabled: true },
        browser: { enabled: false },
        presentation: { default: "summary" },
      },
    });
    service = await createService(config);
    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(baseUrl + "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey: "live-agent-prompt-scope-access" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json() as { token: string };
    const client = createTestClient(() => baseUrl, token, 320_000);
    const version = (await client.json("/api/health")).serviceVersion;

    if (scenario === "prompt") {
      const openAgent = (await client.createSession("live-prompt-open")).id;
      const closedAgent = (await client.createSession("live-prompt-closed")).id;
      await client.json(`/api/sessions/${openAgent}/instructions`, {
        instructions: "Prompt scope open agent.",
      }, "PUT");
      await client.json(`/api/sessions/${closedAgent}/skills`, {
        overrides: {
          cron: false,
          monitor: false,
          goal: false,
          memory: false,
          web: false,
          write: false,
          "skill-creator": false,
        },
      }, "PUT");
      const goal = await client.json("/api/goals", {
        title: goalSentinel,
        description: "Synthetic goal used to verify ordinary prompts do not preload goals.",
        milestones: ["verify prompt scope"],
      }, "POST") as { id: string };
      await client.json("/api/memories", {
        text: "Synthetic global memory for prompt scope verification.",
        source: "live-agent-prompt-scope",
      }, "POST");

      const subagentRun = await client.startRun(
        `请只调用一次subagent工具，严格使用参数：{"mode":"single","tasks":[{"agent":"worker","task":"不要调用任何工具，只回复LIVE_AGENT_PROMPT_CHILD_OK，不要解释。"}]}。等待真实结果后只回复LIVE_AGENT_PROMPT_PARENT_OK。不要重试。`,
        openAgent,
      );
      terminalEvent(await subagentRun.done);
      assert.ok(proxy.traces.length >= 2, "parent and child should each make a real model request");
      const parent = proxy.traces.find((trace) => !trace.systemMarkers.subagentRole);
      const child = proxy.traces.find((trace) => trace.systemMarkers.subagentRole);
      assert.ok(parent && child);
      for (const marker of [
        "globalIdentitySentinel", "longTermMemory", "schedule", "monitor", "goal",
        "skills", "web", "weather",
      ] as const) {
        assert.equal(parent.systemMarkers[marker], true, `parent must describe ${marker}`);
      }
      assert.equal(parent.systemMarkers.activeGoalSentinel, false);
      for (const marker of [
        "globalIdentitySentinel", "longTermMemory", "web", "weather",
      ] as const) {
        assert.equal(child.systemMarkers[marker], true, `child must describe ${marker}`);
      }
      assert.equal(child.systemMarkers.activeGoalSentinel, false);
      for (const marker of ["instructions", "schedule", "monitor"] as const) {
        assert.equal(child.systemMarkers[marker], false, `child must not describe ${marker}`);
        assert.equal(child.toolNames.includes(marker), false, `child must not expose ${marker}`);
      }
      assert.equal(child.toolNames.includes("skills"),true);
      assert.equal(child.systemMarkers.skills,true);
      assert.equal(parent.calls.some((call) => call.name === "subagent"), true);
      assert.match(proxy.traces.flatMap((trace) => trace.toolResults).join("\n"), /LIVE_AGENT_PROMPT_CHILD_OK/);

      const beforeClosed = proxy.traces.length;
      const closedRun = await client.startRun("请不调用任何工具，只回复LIVE_AGENT_PROMPT_CLOSED_OK。", closedAgent);
      terminalEvent(await closedRun.done);
      const closedTraces = proxy.traces.slice(beforeClosed);
      assert.equal(closedTraces.length, 1, "ordinary chat should make one model request");
      const closed = closedTraces[0]!;
      assert.equal(closed.systemMarkers.globalIdentitySentinel, true);
      assert.equal(closed.systemMarkers.activeGoalSentinel, false);
      for (const marker of [
        "longTermMemory", "write", "skills", "schedule", "monitor", "goal", "web",
      ] as const) assert.equal(closed.systemMarkers[marker], false, `closed agent must not describe ${marker}`);
      for (const tool of ["schedule", "monitor", "goal", "memory", "memory_search", "skills", "search_web", "web_fetch", "write", "edit"])
        assert.equal(closed.toolNames.includes(tool), false, `closed agent must not expose ${tool}`);

      await client.json(`/api/sessions/${closedAgent}/skills`, {
        overrides: {
          cron: true,
          monitor: true,
          goal: true,
          memory: true,
          web: true,
          write: true,
          "skill-creator": true,
        },
      }, "PUT");
      const beforeReopen = proxy.traces.length;
      const reopenedRun = await client.startRun("请不调用任何工具，只回复LIVE_AGENT_PROMPT_REOPEN_OK。", closedAgent);
      terminalEvent(await reopenedRun.done);
      const reopened = proxy.traces.slice(beforeReopen).at(-1)!;
      for (const tool of ["schedule", "monitor", "goal", "memory", "memory_search", "skills", "search_web", "web_fetch", "write", "edit"])
        assert.equal(reopened.toolNames.includes(tool), true, `reopened agent must expose ${tool}`);
      for (const marker of ["longTermMemory", "write", "skills", "schedule", "monitor", "goal", "web"] as const)
        assert.equal(reopened.systemMarkers[marker], true, `reopened agent must describe ${marker}`);

      const beforeGoalQuery = proxy.traces.length;
      const goalRun = await client.startRun(
        `请只调用一次goal工具，严格使用参数：{"action":"list","title":"-"}。然后只在工具结果包含${goalSentinel}时回复LIVE_GOAL_QUERY_OK，否则回复LIVE_GOAL_QUERY_MISSING。不要重试。`,
        openAgent,
      );
      terminalEvent(await goalRun.done);
      const goalTraces = proxy.traces.slice(beforeGoalQuery);
      const goalRequest = goalTraces.find((trace) => trace.calls.some((call) => {
        if (call.name !== "goal") return false;
        try { return (JSON.parse(call.arguments) as { action?: string }).action === "list"; }
        catch { return false; }
      }));
      assert.ok(goalRequest, "goal list was not actually called");
      assert.match(goalTraces.flatMap((trace) => trace.toolResults).join("\n"), new RegExp(goalSentinel));
      for (const trace of goalTraces) {
        assert.equal(trace.systemMarkers.schedule, true, "open agent must remain enabled");
        assert.equal(trace.systemMarkers.goal, true, "open agent must remain enabled");
      }
      assert.ok(proxy.traces.every((trace) => !trace.systemMarkers.activeGoalSentinel));

      process.stdout.write(`[PASS] agent-prompt-scope:${JSON.stringify({
        serviceVersion: version,
        goalId: goal.id,
        modelRequests: proxy.traces.length,
        closedToolCount: closed.toolNames.length,
        childBusinessGuidance: false,
      })}\n`);
    } else {
      const dreamAgent = (await client.createSession("live-dream-scope")).id;
      const otherAgent = (await client.createSession("live-dream-other")).id;
      const otherInstructions = "Other agent rules remain unchanged.";
      const otherInstructionsFile = join(dataDir, "sessions", otherAgent, "INSTRUCTIONS.md");
      await client.json(`/api/sessions/${dreamAgent}/instructions`, {
        instructions: "## 会话用途\nDream scope verification\n\nDream scope base rule.",
      }, "PUT");
      await client.json(`/api/sessions/${otherAgent}/instructions`, {
        instructions: otherInstructions,
      }, "PUT");
      const otherInstructionsBaseline = await readFile(otherInstructionsFile, "utf8");

      const chat = await client.startRun(
        `请不调用任何工具，只回复LIVE_DREAM_SOURCE_OK。本条消息包含三条待整理事实，三个标记字符串必须原样出现在对应建议正文中：1. 本智能体只整理新能源政策与电池行业信息，忽略娱乐新闻，结果用中文要点；规则正文包含${localDreamSentinel}。2. 书房打印机型号是${globalDreamSentinel}，这是跨智能体按需查询的设备事实，请保存在长期记忆，不放进每轮必读的用户资料。3. 我还没有确定${pendingDreamSentinel}是否在所有智能体长期适用。`,
        dreamAgent,
      );
      terminalEvent(await chat.done);

      const beforeDream = proxy.traces.length;
      const dreamState = await client.json("/api/dream/run", {}, "POST") as {
        lastRun: { status: string; changed: string[] };
        cursors: Record<string,string>;
        pending: { id: string; suggestedTarget: string; text: string }[];
      };
      const dreamTraces = proxy.traces.slice(beforeDream);
      const dreamRequest = dreamTraces.find((trace) => trace.toolNames.includes("propose_notes"));
      assert.ok(dreamRequest, "Dream did not declare propose_notes to the real model");
      assert.equal(dreamRequest.calls.filter((call) => call.name === "propose_notes").length, 1);
      assert.equal(dreamState.lastRun.status, "completed");
      assert.ok(dreamState.cursors[dreamAgent],"the source cursor advances only after a complete successful source round");
      assert.equal(dreamState.pending.length, 1);
      assert.match(dreamState.pending[0]!.text, new RegExp(pendingDreamSentinel));

      const profile = (await client.json("/api/profile")) as { soul: string; user: string };
      const instructions = await readFile(join(dataDir, "sessions", dreamAgent, "INSTRUCTIONS.md"), "utf8");
      const memories = (await client.json("/api/memories")) as { memories: { text: string }[] };
      assert.equal(profile.user, "");
      assert.equal(profile.soul, "");
      assert.match(instructions, new RegExp(localDreamSentinel));
      assert.doesNotMatch(instructions, new RegExp(`${globalDreamSentinel}|${pendingDreamSentinel}`));
      assert.equal(memories.memories.length, 1);
      assert.match(memories.memories[0]!.text, new RegExp(globalDreamSentinel));
      assert.doesNotMatch(memories.memories[0]!.text, new RegExp(localDreamSentinel));
      const persistedOtherInstructions = await readFile(otherInstructionsFile, "utf8");
      assert.equal(persistedOtherInstructions, otherInstructionsBaseline);
      await assert.rejects(stat(join(dataDir, "information", `${dreamAgent}.json`)), { code: "ENOENT" });

      const resolved = await client.json(
        `/api/dream/pending/${dreamState.pending[0]!.id}`,
        { action: "apply", target: "memory" },
        "POST",
      ) as { pending: unknown[] };
      const afterMemories = (await client.json("/api/memories")) as { memories: { text: string }[] };
      assert.equal(resolved.pending.length, 0);
      assert.equal(afterMemories.memories.length, 2);
      assert.match(afterMemories.memories.map((item) => item.text).join("\n"), new RegExp(pendingDreamSentinel));

      process.stdout.write(`[PASS] agent-dream-scope:${JSON.stringify({
        serviceVersion: version,
        dreamModelRequests: dreamTraces.length,
        changed: dreamState.lastRun.changed,
        pendingResolvedAsAdd: true,
        otherAgentUnchanged: true,
      })}\n`);
    }
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    const cleanup: Array<{ label: string; promise: Promise<unknown> }> = [];
    if (service) cleanup.push({ label: "service", promise: service.close() });
    if (http) {
      if ("closeAllConnections" in http) http.closeAllConnections();
      cleanup.push({
        label: "http",
        promise: new Promise<void>((resolve, reject) =>
          http!.close((error) => error ? reject(error) : resolve()),
        ),
      });
    }
    if (proxy) cleanup.push({ label: "model proxy", promise: proxy.close() });
    const results = await Promise.allSettled(cleanup.map((item) => item.promise));
    if (root) await rm(root, { recursive: true, force: true });
    const failures = results
      .map((result, index) => result.status === "rejected"
        ? `${cleanup[index]!.label}: ${String(result.reason)}`
        : undefined)
      .filter(Boolean);
    if (failures.length) {
      const cleanupError = new Error(`Cleanup failed (${failures.join("; ")})`);
      if (executionError === undefined) throw cleanupError;
      console.error(`[FAIL] cleanup: ${cleanupError.message}`);
    }
  }
};

try {
  const options = parseOptions(process.argv.slice(2));
  await execute(options);
} catch (error) {
  process.stderr.write(`[FAIL] agent-prompt-scope: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
