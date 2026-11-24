import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import { createTools } from "../../src/adapters/pi/tools/index.js";
import { createConfig } from "../../src/config/load-config.js";
import { attachUpgradeHandler, createBrowserUpgradeHandler } from "../../src/http/browser-websocket.js";
import {
  browserStatusResponse,
  browserTab,
  browserViewerTicketResponse,
  browserViewportResponse,
} from "../../src/http/contracts/browser.js";
import { createService } from "../support/test-service.js";

const chromeExecutable = process.env.PI_MUSE_TEST_CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const fixtureHtml = `<!doctype html>
<html>
  <head><title>Fixture</title></head>
  <body>
    <h1 id="heading">Fixture Ready</h1>
    <button id="act" onclick="window.__clicks=(window.__clicks||0)+1;document.getElementById('status').textContent='Clicks:'+window.__clicks">Action</button>
    <input id="field" aria-label="Text input" />
    <select id="color" aria-label="Color">
      <option value="red">Red</option>
      <option value="blue">Blue</option>
    </select>
    <a id="dl" href="/download" download="hello.txt">Download File</a>
    <main id="status">Clicks:0</main>
  </body>
</html>`;

const secondHtml = `<!doctype html>
<html>
  <head><title>Second</title></head>
  <body>
    <button id="second" onclick="window.__second=(window.__second||0)+1;document.getElementById('second-count').textContent='Second clicks:'+window.__second">Second action</button>
    <main id="second-count">Second clicks:0</main>
  </body>
</html>`;

const nestedHtml = `<!doctype html>
<html>
  <head><title>Nested</title></head>
  <body>
    <div id="shadow-host"></div>
    <iframe srcdoc="<button id='frame-action'>Frame action</button>"></iframe>
    <script>
      const root = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
      root.innerHTML = '<button id="shadow-action">Shadow action</button>';
    </script>
  </body>
</html>`;

const uploadHtml = `<!doctype html>
<html>
  <head><title>Upload</title></head>
  <body>
    <input id="file-input" type="file" aria-label="Upload file" onchange="document.getElementById('picked').textContent=this.files[0]?.name||''" />
    <div id="picked"></div>
  </body>
</html>`;

const delayedHtml = `<!doctype html>
<html>
  <head><title>Delayed</title></head>
  <body>
    <div id="container">Booting</div>
    <script>
      setTimeout(() => {
        const el = document.createElement('p');
        el.id = 'late';
        el.textContent = 'Late Ready';
        document.getElementById('container').appendChild(el);
      }, 150);
    </script>
  </body>
</html>`;

const waitFor = async (predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

const extractRef = (tree: string, pattern: RegExp): string => {
  const line = tree.split("\n").find((entry) => pattern.test(entry));
  const ref = line?.match(/\[ref=(s\d+:(?:f\d+)?e\d+)\]/)?.[1];
  assert.ok(ref, `Missing snapshot ref for ${pattern} in:\n${tree}`);
  return ref;
};

const hasChrome = await stat(chromeExecutable).then(() => true, () => false);

test("browser REST, cookie boundary, viewport sync, WS frames, SSE events and unified tool drive real system Chrome", {
  skip: hasChrome ? false : `Chrome executable not found at ${chromeExecutable}`,
  timeout: 90_000,
}, async (t) => {
  const fixtureServer = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/download") {
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="hello.txt"',
      });
      res.end("downloaded-body");
      return;
    }
    const html = path === "/second"
      ? secondHtml
      : path === "/nested"
        ? nestedHtml
        : path === "/upload"
          ? uploadHtml
          : path === "/delayed"
            ? delayedHtml
            : fixtureHtml;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  fixtureServer.listen(0, "127.0.0.1");
  await once(fixtureServer, "listening");
  t.after(() => fixtureServer.close());
  const fixtureAddr = fixtureServer.address();
  assert.ok(fixtureAddr && typeof fixtureAddr !== "string");
  const fixtureUrl = `http://127.0.0.1:${fixtureAddr.port}`;

  // 1. Disabled state still exposes GET /api/browser/status (200) and rejects viewer-ticket (503)
  const disabledDir = await mkdtemp(join(tmpdir(), "pi-muse-browser-disabled-"));
  t.after(() => rm(disabledDir, { recursive: true, force: true }));
  const disabledService = await createService(createConfig({
    runtime: { dataDir: disabledDir },
    tools: { browser: { enabled: false } },
  }));
  t.after(() => disabledService.close());
  const disabledToken = disabledService.auth.login();
  const disabledStatusRes = await disabledService.app.request("/api/browser/status", {
    headers: { Authorization: `Bearer ${disabledToken}` },
  });
  assert.equal(disabledStatusRes.status, 200);
  const disabledStatus = browserStatusResponse.parse(await disabledStatusRes.json());
  assert.equal(disabledStatus.enabled, false);
  assert.equal(disabledStatus.running, false);
  assert.equal(disabledStatus.viewerPath, null);
  const disabledTicketRes = await disabledService.app.request("/api/browser/viewer-ticket", {
    method: "POST",
    headers: { Authorization: `Bearer ${disabledToken}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(disabledTicketRes.status, 503);

  // 2. Enabled live service with HTTP + WS upgrade handler + SSE stream
  const dataDir = await mkdtemp(join(tmpdir(), "pi-muse-browser-int-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = await createService(createConfig({
    runtime: { dataDir },
    tools: { browser: { enabled: true, allowPrivateTargets: true, executablePath: chromeExecutable } },
  }));
  t.after(() => service.close());

  const apiServer = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!apiServer.listening) await once(apiServer, "listening");
  const browserWs = createBrowserUpgradeHandler(service.browser);
  const detachUpgrade = attachUpgradeHandler(apiServer as unknown as Server, browserWs.handle);
  t.after(async () => {
    detachUpgrade();
    browserWs.close();
    if ("closeAllConnections" in apiServer) apiServer.closeAllConnections();
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  });

  const apiAddr = apiServer.address();
  assert.ok(apiAddr && typeof apiAddr !== "string");
  const apiUrl = `http://127.0.0.1:${apiAddr.port}`;
  const wsOrigin = `ws://127.0.0.1:${apiAddr.port}`;
  const token = service.auth.login()!;

  const reqJson = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : undefined;
    assert.equal(response.ok, true, `${method} ${path} failed (${response.status}): ${text}`);
    return json;
  };

  // Status before Chrome start must report running=false without lazy launching
  const beforeLaunch = browserStatusResponse.parse(await reqJson("/api/browser/status"));
  assert.equal(beforeLaunch.enabled, true);
  assert.equal(beforeLaunch.running, false);
  assert.equal(beforeLaunch.viewerPath, "/browser");
  assert.equal(beforeLaunch.viewport.preset, "desktop");

  // Viewer ticket -> /browser/launch cookie scoping verification
  const viewerTicket = browserViewerTicketResponse.parse(await reqJson("/api/browser/viewer-ticket", {}));
  const launchRes = await fetch(`${apiUrl}${viewerTicket.launchPath}`, { redirect: "manual" });
  assert.equal(launchRes.status, 303);
  assert.equal(launchRes.headers.get("location"), "/browser");
  const setCookie = launchRes.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /pi_muse_browser=([^;]+)/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookiePair = setCookie.split(";")[0]!;

  // Replaying consumed viewer ticket must fail 401
  const replayRes = await fetch(`${apiUrl}${viewerTicket.launchPath}`, { redirect: "manual" });
  assert.equal(replayRes.status, 401);

  // Cookie authorizes /api/browser/status and /api/browser/ws-ticket, but NOT viewer-ticket or /api/sessions
  assert.equal((await fetch(`${apiUrl}/api/browser/status`, { headers: { Cookie: cookiePair } })).status, 200);
  assert.equal((await fetch(`${apiUrl}/api/browser/ws-ticket`, { method: "POST", headers: { Cookie: cookiePair, "content-type": "application/json" }, body: "{}" })).status, 200);
  assert.equal((await fetch(`${apiUrl}/api/browser/viewer-ticket`, { method: "POST", headers: { Cookie: cookiePair, "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${apiUrl}/api/sessions`, { headers: { Cookie: cookiePair } })).status, 401);

  // Connect workspace SSE stream to observe browser_updated events
  const sseController = new AbortController();
  t.after(() => sseController.abort());
  const sseRes = await fetch(`${apiUrl}/api/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: sseController.signal,
  });
  assert.equal(sseRes.status, 200);
  const sseReader = sseRes.body!.getReader();
  const sseEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await sseReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let eventName = "";
          let dataLine = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
          }
          if (eventName && dataLine) sseEvents.push({ event: eventName, data: JSON.parse(dataLine) });
        }
      }
    } catch { /* aborted at teardown */ }
  })();
  await waitFor(() => sseEvents.some((e) => e.event === "ready"), "SSE ready");

  // Open WS with ticket, lazily launch Chrome & verify ready + frames + viewport switch
  const { ticket: wsTicket } = await reqJson("/api/browser/ws-ticket", {}) as { ticket: string };
  const ws = new WebSocket(`${wsOrigin}/ws/browser?ticket=${encodeURIComponent(wsTicket)}`);
  t.after(() => ws.close());
  const wsMessages: Array<Record<string, unknown>> = [];
  const frames: Array<{ tabId: string; frameId: number; sessionId: string; width: number; height: number }> = [];
  ws.on("message", (raw, isBinary) => {
    if (!isBinary) {
      wsMessages.push(JSON.parse(raw.toString()));
      return;
    }
    const bytes = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayBuffer);
    const metaLen = bytes.readUInt32BE(0);
    const meta = JSON.parse(bytes.subarray(4, 4 + metaLen).toString("utf8")) as {
      tabId: string; frameId: number; sessionId: string; width: number; height: number;
    };
    frames.push(meta);
    ws.send(JSON.stringify({ type: "frame_ack", frameId: meta.frameId, sessionId: meta.sessionId }));
  });
  await waitFor(() => wsMessages.some((m) => m.type === "ready"), "WS ready");

  const tab = browserTab.parse(await reqJson("/api/browser/tabs", { url: fixtureUrl }));
  await waitFor(() => frames.some((f) => f.tabId === tab.id), "initial desktop JPEG frame");

  // Dynamic viewport switch to mobile -> updates WS + SSE + Chrome frame dimensions
  const vpRes = browserViewportResponse.parse(await reqJson("/api/browser/viewport", { preset: "mobile" }, "PUT"));
  assert.equal(vpRes.viewport.width, 390);
  assert.equal(vpRes.viewport.mobile, true);
  await waitFor(
    () => wsMessages.some((m) => m.type === "viewport" && (m.viewport as { preset: string }).preset === "mobile"),
    "WS mobile viewport push",
  );
  await waitFor(
    () => frames.some((f) => f.tabId === tab.id && f.width === 390),
    `mobile 390px JPEG frame (tab=${tab.id}, got=${JSON.stringify(frames.map((f) => [f.tabId, f.width, f.height]))})`,
  );
  await waitFor(
    () => sseEvents.some((e) => e.event === "browser_updated" && e.data.scope === "viewport"),
    "SSE browser_updated viewport",
  );

  // Switch back to desktop via WS viewport message
  ws.send(JSON.stringify({ type: "viewport", preset: "desktop" }));
  await waitFor(
    () => wsMessages.some((m) => m.type === "viewport" && (m.viewport as { preset: string }).preset === "desktop"),
    "WS desktop viewport confirmation",
  );

  // Upload & Download + realtime WS files broadcast
  await reqJson(`/api/browser/tabs/${tab.id}/navigation`, { action: "navigate", url: `${fixtureUrl}/upload` });
  const uploadSnap = await service.browser!.snapshot(tab.id);
  const fileRef = extractRef(uploadSnap.tree, /Upload file/);
  await service.browser!.act(tab.id, { steps: [{ action: "click", ref: fileRef }] });
  await waitFor(
    () => wsMessages.some((m) => m.type === "files" && Array.isArray(m.uploads) && m.uploads.length === 1),
    "WS upload chooser push",
  );
  const uploadId = (await service.browser!.listFiles()).uploads[0]!.id;
  await reqJson(`/api/browser/uploads/${uploadId}`, {
    files: [{ name: "probe.txt", mimeType: "text/plain", contentBase64: Buffer.from("ok").toString("base64") }],
  });
  await waitFor(async () => /probe\.txt/.test((await service.browser!.snapshot(tab.id)).text), "uploaded filename rendered");

  // Unified agent browser tool: navigate, snapshot, act (type + select + click), screenshot, wait, request_handoff
  const tools = createTools({
    root: dataDir,
    memory: service.memory,
    jobs: service.jobs,
    browser: service.browser,
  });
  const browserTool = tools.find((tool) => tool.name === "browser")!;
  assert.ok(browserTool, "unified browser tool must be registered");
  const callTool = async (params: Record<string, unknown>) => {
    const result = await browserTool.execute("tc-1", params as never, undefined, undefined, undefined as never);
    assert.notEqual(result.isError, true, `tool returned error: ${JSON.stringify(result.content)}`);
    const textBlock = result.content.find((block) => block.type === "text") as { type: "text"; text: string };
    return { raw: result, json: JSON.parse(textBlock.text) as Record<string, unknown> };
  };

  await callTool({ action: "navigate", tabId: tab.id, url: fixtureUrl });
  const snapRes = await callTool({ action: "snapshot", tabId: tab.id });
  const tree = String(snapRes.json.tree);
  const inputRef = extractRef(tree, /textbox "Text input"/);
  const selectRef = extractRef(tree, /combobox "Color"/);
  const btnRef = extractRef(tree, /button "Action"/);

  const actRes = await callTool({
    action: "act",
    tabId: tab.id,
    steps: [
      { action: "type", ref: inputRef, text: "agent-v2" },
      { action: "select", ref: selectRef, label: "Blue" },
      { action: "click", ref: btnRef },
    ],
  });
  assert.equal(actRes.json.ok, true);
  assert.match(String((actRes.json.snapshot as { text: string }).text), /Clicks:1/);

  // Screenshot returns valid JSON metadata + JPEG image block
  const shotRes = await callTool({ action: "screenshot", tabId: tab.id });
  assert.equal(shotRes.json.ok, true);
  assert.equal(shotRes.json.untrusted, true);
  const imageBlock = shotRes.raw.content.find((block) => block.type === "image") as { type: "image"; mimeType: string; data: string } | undefined;
  assert.equal(imageBlock?.mimeType, "image/jpeg");
  const jpegHeader = Buffer.from(imageBlock!.data, "base64").subarray(0, 2);
  assert.deepEqual([...jpegHeader], [0xff, 0xd8]);

  // Shadow DOM + iframe snapshot refs
  await callTool({ action: "navigate", tabId: tab.id, url: `${fixtureUrl}/nested` });
  const nestedSnap = await callTool({ action: "snapshot", tabId: tab.id });
  assert.match(String(nestedSnap.json.tree), /button "Shadow action"/);
  assert.match(String(nestedSnap.json.tree), /button "Frame action" \[ref=s\d+:f\d+e\d+\]/);

  // Wait for delayed text
  await callTool({ action: "navigate", tabId: tab.id, url: `${fixtureUrl}/delayed` });
  const waitRes = await callTool({ action: "wait", tabId: tab.id, text: "Late Ready", timeoutMs: 4000 });
  assert.equal(waitRes.json.ok, true);
  assert.equal(waitRes.json.waited, "text");

  // request_handoff -> WS handoff push + SSE browser_updated -> DELETE /api/browser/handoff clears both
  const handoffRes = await callTool({ action: "request_handoff", tabId: tab.id, reason: "Please verify SMS code" });
  assert.equal(handoffRes.json.ok, true);
  await waitFor(
    () => wsMessages.some((m) => m.type === "handoff" && (m.handoff as { reason?: string } | null)?.reason === "Please verify SMS code"),
    "WS handoff request",
  );
  await waitFor(
    () => sseEvents.some((e) => e.event === "browser_updated" && e.data.scope === "handoff" && e.data.handoff !== null),
    "SSE browser_updated handoff",
  );
  await reqJson("/api/browser/handoff", undefined, "DELETE");
  const statusAfterResolve = browserStatusResponse.parse(await reqJson("/api/browser/status"));
  assert.equal(statusAfterResolve.handoff, null);
  await waitFor(
    () => wsMessages.some((m) => m.type === "handoff" && m.handoff === null),
    "WS handoff cleared",
  );
});
