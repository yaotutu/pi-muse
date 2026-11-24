import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolPresentation } from "../../src/adapters/ag-ui/tool-presentation.js";
import { createBrowserService, normalizeBrowserViewport } from "../../src/features/browser/browser-service.js";
import {
  BrowserError,
  type BrowserDownload,
  type BrowserDownloadStore,
  type BrowserDriver,
  type BrowserStreamClient,
  type BrowserTab,
  type BrowserUpdateScope,
  type BrowserUpload,
  type BrowserViewport,
  type BrowserHandoff,
} from "../../src/features/browser/types.js";
import { createWorkspaceEvents } from "../../src/features/workspace/workspace-events.js";

const makeTab = (id = "tab-1", active = true): BrowserTab => ({
  id,
  title: "Fixture",
  url: "https://example.test/",
  active,
  loading: false,
});

const createServiceHarness = () => {
  let running = false;
  let tabs = [makeTab()];
  let viewport: BrowserViewport = { preset: "desktop", width: 1280, height: 800, mobile: false };
  let uploads: BrowserUpload[] = [];
  let downloads: BrowserDownload[] = [];
  let tabsListener: ((next: BrowserTab[]) => void) | undefined;
  let uploadsListener: (() => void) | undefined;
  let storeChangedListener: (() => void) | undefined;
  let startCalls = 0;

  const downloadStore: BrowserDownloadStore = {
    reconcileOnStart: async () => undefined,
    list: async () => downloads,
    capture: async () => undefined,
    content: async () => { throw new BrowserError("DOWNLOAD_NOT_FOUND", "Not found"); },
    remove: async () => undefined,
    close: async () => undefined,
    onChanged: (listener) => { storeChangedListener = listener; },
  };

  const driver: BrowserDriver = {
    start: async () => { startCalls++; running = true; },
    close: async () => { running = false; },
    isRunning: () => running,
    listTabs: async () => {
      if (!running) { startCalls++; running = true; }
      return tabs;
    },
    newTab: async (url) => {
      const next = makeTab("tab-2", true);
      if (url) next.url = url;
      tabs = [makeTab("tab-1", false), next];
      return next;
    },
    closeTab: async (tabId) => {
      tabs = tabs.filter((t) => t.id !== tabId);
      if (tabs.length) tabs[0]!.active = true;
      tabsListener?.(tabs);
      return tabs;
    },
    activateTab: async (tabId) => {
      tabs = tabs.map((t) => ({ ...t, active: t.id === tabId }));
      return tabs.find((t) => t.id === tabId)!;
    },
    navigate: async () => tabs[0]!,
    history: async () => tabs[0]!,
    reload: async () => tabs[0]!,
    getViewport: () => ({ ...viewport }),
    setViewport: async (next) => {
      viewport = { ...next };
      return { ...viewport };
    },
    input: async () => undefined,
    act: async () => undefined,
    snapshot: async () => ({ tab: tabs[0]!, title: "Fixture", url: tabs[0]!.url, tree: "", text: "ok", truncated: false }),
    screenshot: async () => ({ tab: tabs[0]!, mimeType: "image/jpeg", width: viewport.width, height: viewport.height, dataBase64: "AQ==" }),
    wait: async (_tabId, input) => ({ ok: true, waited: input.text ? "text" : "delay" }),
    startScreencast: async () => undefined,
    stopScreencast: async () => undefined,
    listUploads: async () => uploads,
    setUploadFiles: async () => undefined,
    cancelUpload: async () => undefined,
    onTabsChanged: (listener) => { tabsListener = listener; },
    onUploadsChanged: (listener) => { uploadsListener = listener; },
  };

  const stateChanges: Array<{ scope: BrowserUpdateScope; handoff?: BrowserHandoff | null }> = [];
  const service = createBrowserService(driver, downloadStore, {
    onStateChange: (scope, handoff) => stateChanges.push({ scope, handoff }),
  });

  const makeClient = () => {
    const sentText: unknown[] = [];
    const client: BrowserStreamClient = {
      sendText: (msg) => sentText.push(JSON.parse(msg)),
      sendBinary: () => undefined,
      close: () => undefined,
      bufferedAmount: () => 0,
    };
    return { client, sentText };
  };

  return {
    service,
    stateChanges,
    makeClient,
    startCalls: () => startCalls,
    setUploads: (next: BrowserUpload[]) => { uploads = next; uploadsListener?.(); },
    setDownloads: (next: BrowserDownload[]) => { downloads = next; storeChangedListener?.(); },
  };
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

test("normalizeBrowserViewport validates presets and dimensions", () => {
  assert.deepEqual(normalizeBrowserViewport({ preset: "desktop" }), {
    preset: "desktop",
    width: 1280,
    height: 800,
    mobile: false,
  });
  assert.deepEqual(normalizeBrowserViewport({ preset: "mobile" }), {
    preset: "mobile",
    width: 390,
    height: 720,
    mobile: true,
  });
  assert.deepEqual(normalizeBrowserViewport({ preset: "custom", width: 500, height: 900 }), {
    preset: "custom",
    width: 500,
    height: 900,
    mobile: true,
  });
  assert.throws(() => normalizeBrowserViewport({ preset: "custom", width: 500 }), BrowserError);
  assert.throws(() => normalizeBrowserViewport({ preset: "desktop", width: 100 }), BrowserError);
});

test("status stays non-launching, viewport/files/handoff push over WS and tab close clears handoff", async (t) => {
  const h = createServiceHarness();
  t.after(() => h.service.close());

  const initial = await h.service.status();
  assert.equal(initial.running, false);
  assert.equal(initial.viewerPath, "/browser");
  assert.equal(h.startCalls(), 0);

  const ws = h.makeClient();
  const attached = h.service.attachClient(ws.client);
  await flush();
  assert.equal(ws.sentText.some((m) => (m as { type: string }).type === "ready"), true);

  // Viewport change via REST + WS
  await h.service.setViewport({ preset: "mobile" });
  assert.equal(ws.sentText.some((m) => (m as { type: string; viewport?: BrowserViewport }).type === "viewport" && (m as { viewport?: BrowserViewport }).viewport?.preset === "mobile"), true);
  attached.handleMessage(JSON.stringify({ type: "viewport", preset: "custom", width: 800, height: 600, mobile: false }));
  await flush();
  assert.equal(h.service.getViewport().width, 800);

  // Handoff lifecycle + automatic clear when bound tab closes
  const handoff = await h.service.requestHandoff("tab-1", "Complete SMS verification");
  assert.equal(handoff.tabId, "tab-1");
  assert.equal((await h.service.status()).handoff?.id, handoff.id);
  assert.equal(ws.sentText.some((m) => (m as { type: string; handoff?: { id?: string } }).type === "handoff" && (m as { handoff?: { id?: string } }).handoff?.id === handoff.id), true);

  await h.service.closeTab("tab-1");
  await flush();
  assert.equal((await h.service.status()).handoff, null);
  assert.deepEqual(ws.sentText.at(-1), { type: "handoff", handoff: null });
  assert.deepEqual(h.service.resolveHandoff(), { ok: true });

  // Re-request & explicit resolve
  await h.service.newTab("https://example.test/");
  await h.service.requestHandoff("tab-2", "Login");
  assert.deepEqual(h.service.resolveHandoff(), { ok: true });

  // Realtime files push from driver uploads listener and store download listener
  h.setUploads([{ id: "u-1", tabId: "tab-2", multiple: false, accept: ".pdf", createdAt: new Date().toISOString() }]);
  await flush();
  assert.equal(ws.sentText.some((m) => (m as { type: string; uploads?: unknown[] }).type === "files" && (m as { uploads?: unknown[] }).uploads?.length === 1), true);
  h.setDownloads([{ id: "d-1", tabId: "tab-2", name: "a.pdf", status: "completed", bytes: 42, createdAt: new Date().toISOString(), error: null }]);
  await flush();
  assert.equal(ws.sentText.some((m) => (m as { type: string; downloads?: unknown[] }).type === "files" && (m as { downloads?: unknown[] }).downloads?.length === 1), true);

  // Viewer ticket single-use + session lookup + 10 分钟有效期
  const ticket = h.service.createViewerTicket();
  const match = ticket.launchPath.match(/ticket=([^&]+)/);
  assert.ok(match?.[1]);
  const ticketLifetimeMs = Date.parse(ticket.expiresAt) - Date.now();
  assert.ok(
    ticketLifetimeMs > 9 * 60_000 && ticketLifetimeMs <= 10 * 60_000,
    `viewer ticket must stay valid for about 10 minutes, got ${ticketLifetimeMs}ms`,
  );
  const session = h.service.consumeViewerTicket(match[1]);
  assert.ok(session);
  assert.equal(h.service.consumeViewerTicket(match[1]), undefined);
  assert.equal(h.service.hasViewerSession(session.sessionId), true);
  assert.equal(h.service.hasViewerSession("unknown-session"), false);

  // WS ticket 同样按 10 分钟有效，且消费后立即失效
  const wsTicket = h.service.createTicket();
  const wsLifetimeMs = Date.parse(wsTicket.expiresAt) - Date.now();
  assert.ok(
    wsLifetimeMs > 9 * 60_000 && wsLifetimeMs <= 10 * 60_000,
    `ws ticket must stay valid for about 10 minutes, got ${wsLifetimeMs}ms`,
  );
  assert.equal(h.service.consumeTicket(wsTicket.ticket), true);
  assert.equal(h.service.consumeTicket(wsTicket.ticket), false);

  // Screenshot & wait validation
  const shot = await h.service.screenshot("tab-2");
  assert.equal(shot.mimeType, "image/jpeg");
  assert.equal((await h.service.wait("tab-2", { text: "Hello", timeoutMs: 200 })).waited, "text");
  await assert.rejects(h.service.wait("tab-2", { timeoutMs: 10 }), BrowserError);
});

test("tool presentation summarizes unified browser tool cleanly and workspaceEvents emits browser_updated", () => {
  const presentation = createToolPresentation({ default: "summary", overrides: {} });
  assert.equal(presentation.presentResult("browser", "{\"ok\":true}"), "已执行浏览器操作");
  assert.equal(presentation.presentResult("browser", "已执行浏览器操作"), "已执行浏览器操作");

  const events = createWorkspaceEvents();
  const received: unknown[] = [];
  events.subscribe({
    notify: (event) => received.push(event),
    close: () => undefined,
  });
  events.browserChanged("handoff", {
    id: "h-1",
    tabId: "tab-1",
    reason: "2FA",
    url: "https://example.test/",
    createdAt: new Date().toISOString(),
  });
  assert.equal(received.length, 1);
  assert.equal((received[0] as { event: string }).event, "browser_updated");
});
