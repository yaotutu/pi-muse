import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { attachUpgradeHandler, createBrowserUpgradeHandler } from "../../src/http/browser-websocket.js";
import { parseLiveOptions, type LiveOptions } from "./options.js";

const execute = async (options: LiveOptions) => {
  const { createService, enableBuiltinSkills } = await import("../support/test-service.js");
  const { createConfig } = await import("../../src/config/load-config.js");
  const { createLiveModel, redactApiKey } = await import("../support/live-model.js");
  const { createTestClient } = await import("../support/http-client.js");

  const raw = JSON.parse(await readFile(options.configPath, "utf8")) as {
    model?: unknown;
    tools?: { browser?: { executablePath?: string; cdpUrl?: string } };
  };
  const model = createConfig({ server: { host: "127.0.0.1" }, model: raw.model });
  if (!model.configured || !model.baseUrl || !model.modelId) {
    throw new Error("Model configuration is required");
  }

  let root: string | undefined;
  let fixtureServer: ReturnType<typeof createServer> | undefined;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let proxy: Awaited<ReturnType<typeof createLiveModel>> | undefined;
  let http: ReturnType<typeof serve> | undefined;
  let browserWs: ReturnType<typeof createBrowserUpgradeHandler> | undefined;
  let detachUpgrade: (() => void) | undefined;
  let failure: string | undefined;
  let serviceVersion: unknown;
  const evidence: Array<{ name: string; detail: Record<string, unknown> }> = [];
  const cleanupFailures: string[] = [];
  const accessKey = randomUUID();
  const marker = `BR_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

  const record = (name: string, detail: Record<string, unknown>) => {
    evidence.push({ name, detail });
    process.stdout.write(`[PASS] ${name}\n`);
  };

  try {
    fixtureServer = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (path === "/subagent") {
        res.end(`<!doctype html><html><head><title>Subagent Target</title></head><body><h1 id="sub-marker">SUB_${marker}</h1></body></html>`);
        return;
      }
      if (path === "/login") {
        res.end(`<!doctype html><html><head><title>Login Verification</title></head><body><h1>Manual Login Gate</h1><p>QR code or 2FA verification required here.</p></body></html>`);
        return;
      }
      res.end(`<!doctype html>
<html>
  <head><title>Live Browser Probe</title></head>
  <body>
    <h1>Live Browser Probe</h1>
    <label for="note">Note input</label>
    <input id="note" aria-label="Note input" placeholder="Enter marker" />
    <label for="tier">Tier selector</label>
    <select id="tier" aria-label="Tier selector">
      <option value="alpha">Alpha Option</option>
      <option value="beta">Beta Option</option>
    </select>
    <button id="submit" onclick="document.getElementById('status').textContent='SAVED:' + document.getElementById('note').value + ':' + document.getElementById('tier').value">Apply</button>
    <div id="status">PENDING</div>
  </body>
</html>`);
    });
    fixtureServer.listen(0, "127.0.0.1");
    await once(fixtureServer, "listening");
    const fAddr = fixtureServer.address();
    assert.ok(fAddr && typeof fAddr !== "string");
    const fixtureUrl = `http://127.0.0.1:${fAddr.port}`;

    root = await mkdtemp(join(tmpdir(), "pi-muse-browser-live-"));
    const dataDir = join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    proxy = await createLiveModel({ baseUrl: model.baseUrl, apiKey: model.apiKey });

    service = await createService(createConfig({
      server: { host: "127.0.0.1", accessKey },
      model: {
        baseUrl: proxy.baseUrl,
        id: model.modelId,
        apiKey: "proxy-placeholder",
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
      runtime: {
        dataDir,
        runTimeoutMs: 240_000,
        schedulerIntervalMs: 3_600_000,
        monitorScanIntervalMs: 3_600_000,
      },
      tools: {
        presentation: { default: "summary" },
        web: { enabled: false },
        weather: { enabled: false },
        writable: { enabled: false },
        browser: {
          enabled: true,
          allowPrivateTargets: true,
          executablePath: raw.tools?.browser?.executablePath,
          cdpUrl: raw.tools?.browser?.cdpUrl,
        },
      },
    }));
    await enableBuiltinSkills(service, ["browser"]);

    http = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!http.listening) await once(http, "listening");
    browserWs = createBrowserUpgradeHandler(service.browser);
    detachUpgrade = attachUpgradeHandler(http as never, browserWs.handle);
    const addr = http.address();
    assert.ok(addr && typeof addr !== "string");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const loginRes = await fetch(`${baseUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessKey }),
    });
    assert.equal(loginRes.status, 200);
    const { token } = await loginRes.json() as { token: string };
    const client = createTestClient(() => baseUrl, token, 240_000);
    serviceVersion = (await client.json("/api/health") as { serviceVersion: unknown }).serviceVersion;
    const sessionId = (await client.createSession("Browser live direct")).id;

    const run = async (targetSessionId: string, name: string, instruction: string) => {
      const baseline = proxy!.traces.length;
      const req = await client.startRun(instruction, targetSessionId);
      const events = await req.done;
      assert.equal(events.at(-1)?.type, "RUN_FINISHED", `${name}: model run failed`);
      const traces = proxy!.traces.slice(baseline);
      assert.ok(traces.every((trace) => trace.upstreamStatus === 200), `${name}: upstream returned non-200 status`);
      const calls = traces.flatMap((trace) => trace.calls);
      const messages = await client.json(`/api/conversation?sessionId=${encodeURIComponent(targetSessionId)}`) as {
        messages: Array<{ role: string; content: string }>;
      };
      const lastAssistant = messages.messages.findLast((m) => m.role === "assistant")?.content ?? "";
      return { calls, traces, lastAssistant };
    };

    // 1. Direct unified browser tool: navigate -> snapshot -> act(type, select, click) -> screenshot
    const direct = await run(
      sessionId,
      "direct-browser-act-and-screenshot",
      `请使用 browser 工具打开 ${fixtureUrl}/ ：
1) 先 navigate 并 snapshot 查看页面；
2) 在 "Note input" 输入 ${marker}，在 "Tier selector" 选择 "Beta Option"，然后点击 "Apply" 按钮；
3) 调用一次 browser screenshot 确认画面；
4) 直接告诉我页面上显示的最终状态文本。不要调用其他工具。`,
    );
    assert.ok(direct.calls.some((c) => c.name === "browser"), "model must invoke browser tool");
    assert.ok(
      direct.calls.some((c) => c.name === "browser" && String(c.arguments).includes("screenshot")),
      "model must invoke browser screenshot",
    );
    assert.ok(
      direct.lastAssistant.includes(`SAVED:${marker}:beta`) ||
        direct.traces.flatMap((t) => t.toolResults).join("\n").includes(`SAVED:${marker}:beta`),
      `expected SAVED:${marker}:beta in output, got: ${direct.lastAssistant}`,
    );
    record("direct-browser-act-and-screenshot", { calls: direct.calls.length });

    // 2. Builtin browser subagent delegation (single mode, clean session without prior screenshot baggage)
    const subSessionId = (await client.createSession("Browser live subagent")).id;
    const sub = await run(
      subSessionId,
      "browser-subagent",
      `请使用 subagent 工具（mode 设为 "single"，tasks 中指定 agent 为 "browser"）打开 ${fixtureUrl}/subagent ，读取页面主标题（heading）显示的完整文本后直接告诉我。不要再调用其他工具或猜测源码。`,
    );
    assert.ok(sub.calls.some((c) => c.name === "subagent"), "model must invoke subagent");
    assert.ok(
      sub.traces.some((t) => t.child && t.calls.some((c) => c.name === "browser")),
      "browser child subagent must execute browser tool",
    );
    assert.ok(
      sub.lastAssistant.includes(`SUB_${marker}`) ||
        sub.traces.flatMap((t) => t.toolResults).join("\n").includes(`SUB_${marker}`),
      `expected SUB_${marker}, got: ${sub.lastAssistant}`,
    );
    record("browser-subagent", { calls: sub.calls.length });

    // 3. Model requests manual handoff -> HTTP GET /api/browser/status sees handoff -> DELETE clears it
    const handoffSessionId = (await client.createSession("Browser live handoff")).id;
    const handoffRun = await run(
      handoffSessionId,
      "browser-handoff-lifecycle",
      `请用 browser 工具打开 ${fixtureUrl}/login 。该页面提示需要人工登录/验证码验证，请严格遵守规则不要自行绕过，立即调用 browser 工具的 request_handoff（填写简短 reason 说明需要人工完成登录），然后提醒我去 /browser 操作。`,
    );
    assert.ok(handoffRun.calls.some((c) => c.name === "browser"));
    const statusBefore = await client.json("/api/browser/status") as {
      running: boolean;
      handoff: { id: string; reason: string } | null;
    };
    assert.equal(statusBefore.running, true);
    assert.ok(statusBefore.handoff, "status must expose active handoff requested by model");
    await fetch(`${baseUrl}/api/browser/handoff`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).then((res) => {
      assert.equal(res.status, 200);
    });
    const statusAfter = await client.json("/api/browser/status") as { handoff: unknown };
    assert.equal(statusAfter.handoff, null);
    record("browser-handoff-lifecycle", { handoffId: statusBefore.handoff.id });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    detachUpgrade?.();
    browserWs?.close();
    if (http) {
      if ("closeAllConnections" in http) http.closeAllConnections();
      await new Promise<void>((resolve) => http!.close(() => resolve()));
    }
    if (service) try { await service.close(); } catch { cleanupFailures.push("service close failed"); }
    if (proxy) try { await proxy.close(); } catch { cleanupFailures.push("proxy close failed"); }
    if (fixtureServer) fixtureServer.close();
    if (root && options.keepArtifacts) {
      await writeFile(join(root, "summary.json"), redactApiKey(JSON.stringify({
        passed: failure === undefined && cleanupFailures.length === 0,
        failure: failure ?? null,
        serviceVersion,
        scenarios: evidence,
        realModelRequests: proxy?.traces.length ?? 0,
        cleanupFailures,
      }, null, 2), model.apiKey) + "\n", { mode: 0o600 });
      await writeFile(join(root, "tool-traces.json"), redactApiKey(JSON.stringify(proxy?.traces ?? [], null, 2), model.apiKey) + "\n", { mode: 0o600 });
      process.stdout.write(`[ARTIFACTS] ${root}\n`);
    }
    if (root && !options.keepArtifacts) {
      try { await rm(root, { recursive: true, force: true }); } catch { cleanupFailures.push("temporary cleanup failed"); }
    }
    if (cleanupFailures.length) {
      process.exitCode = 1;
      process.stderr.write(`[CLEANUP-FAIL] ${cleanupFailures.join("; ")}\n`);
    }
  }
};

const outcome = parseLiveOptions(process.argv.slice(2));
if (outcome.kind === "help") {
  console.log(outcome.help.replace("pnpm test:live", "node --import tsx tests/live/browser.ts"));
} else if (outcome.kind === "error") {
  console.error(outcome.message);
  process.exitCode = 1;
} else {
  try {
    await execute(outcome.options);
  } catch (error) {
    console.error(`[FAIL] ${error instanceof Error ? error.message : "Browser live verification failed"}`);
    process.exitCode = 1;
  }
}
