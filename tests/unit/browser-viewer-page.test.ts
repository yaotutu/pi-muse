import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { browserViewerPage } from "../../src/http/browser-viewer-page.js";

const extractScript = () => {
  const match = browserViewerPage.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match?.[1], "browserViewerPage must contain inline script");
  return match[1];
};

type FetchCall = { path: string; init?: RequestInit };

class MockElement {
  id = "";
  tagName = "DIV";
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  className = "";
  tabIndex = 0;
  role = "";
  title = "";
  type = "";
  multiple = false;
  accept = "";
  href = "";
  download = "";
  files: unknown[] = [];
  clientWidth = 390;
  clientHeight = 720;
  width = 1280;
  height = 800;
  children: MockElement[] = [];
  style: Record<string, string> = {};
  onclick?: (event?: Record<string, unknown>) => unknown;
  onkeydown?: (event: Record<string, unknown>) => unknown;
  onkeyup?: (event: Record<string, unknown>) => unknown;
  onchange?: (event?: Record<string, unknown>) => unknown;
  onsubmit?: (event: Record<string, unknown>) => unknown;
  onpointerdown?: (event: Record<string, unknown>) => unknown;
  onpointermove?: (event: Record<string, unknown>) => unknown;
  onpointerup?: (event: Record<string, unknown>) => unknown;
  onpointercancel?: (event: Record<string, unknown>) => unknown;
  onlostpointercapture?: (event: Record<string, unknown>) => unknown;
  oncontextmenu?: (event: Record<string, unknown>) => unknown;
  onauxclick?: (event: Record<string, unknown>) => unknown;
  onwheel?: (event: Record<string, unknown>) => unknown;
  oncompositionstart?: () => void;
  oncompositionend?: (event: Record<string, unknown>) => void;
  oninput?: (event: Record<string, unknown>) => void;

  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
  }
  appendChild(child: MockElement) {
    this.children.push(child);
    return child;
  }
  append(...items: MockElement[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: MockElement[]) {
    this.children = [...items];
  }
  remove() {}
  focus() {}
  click() {
    this.onclick?.({ stopPropagation() {}, preventDefault() {} });
  }
  setPointerCapture() {}
  dispatchEvent(event: Record<string, unknown>) {
    if (event.type === "keydown" || event.key !== undefined) return this.onkeydown?.(event);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  getContext() {
    return {
      clearRect() {},
      drawImage() {},
    };
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

const encodeBinaryFrame = (meta: object) => {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const out = new Uint8Array(4 + metaBytes.length + jpegBytes.length);
  new DataView(out.buffer).setUint32(0, metaBytes.length);
  out.set(metaBytes, 4);
  out.set(jpegBytes, 4 + metaBytes.length);
  return out.buffer;
};

const setupViewerHarness = (options: {
  href?: string;
  innerWidth?: number;
  innerHeight?: number;
  stageWidth?: number;
  stageHeight?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  fetchHandler?: (path: string, init?: RequestInit) => { status?: number; body?: unknown };
} = {}) => {
  const elements = new Map<string, MockElement>();
  const ensureEl = (id: string) => {
    let el = elements.get(id);
    if (!el) {
      el = new MockElement();
      el.id = id;
      if (id === "stage") {
        el.clientWidth = options.stageWidth ?? 390;
        el.clientHeight = options.stageHeight ?? 720;
      }
      if (id === "canvas") {
        el.clientWidth = options.canvasWidth ?? options.stageWidth ?? 390;
        el.clientHeight = options.canvasHeight ?? options.stageHeight ?? 720;
      }
      elements.set(id, el);
    }
    return el;
  };
  for (const id of [
    "status", "loginModal", "loginError", "viewportWrap", "zoomReset",
    "viewportToggle", "mViewportToggle", "filesBadge", "mFilesBadge", "uploadPrompt",
    "handoffBanner", "handoffReason", "handoffDone", "back", "forward", "reload", "go",
    "newTab", "address", "keyboard", "desktopInputToggle", "filesToggle", "mBack", "mForward",
    "tabsToggle", "keyboardToggle", "gestureToggle", "mFilesToggle", "textInput", "textSend",
    "keyEnter", "keyBackspace", "keyTab", "keyEsc", "sheetNewTab", "reconnect", "tabs",
    "mTabsCount", "empty", "canvas", "tabsSheet", "tabsSheetClose", "tabsSheetList",
    "filesPanel", "filesRefresh", "filesClose", "filesStatus", "uploads", "downloads",
    "uploadPromptOpen", "stage", "tapRipple", "nativeInputBar", "login", "accessKey", "loginSubmit",
  ]) {
    ensureEl(id);
  }

  const replacedUrls: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const sockets: MockWebSocket[] = [];
  const storage = new Map<string, string>();
  const url = new URL(options.href ?? "http://127.0.0.1:12330/browser");
  const location = {
    get href() { return url.toString(); },
    protocol: url.protocol,
    host: url.host,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  };

  class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    binaryType = "";
    sent: string[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onerror?: () => void;
    onmessage?: (event: { data: unknown }) => void;
    constructor(public readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => this.onopen?.());
    }
    send(payload: string) {
      this.sent.push(payload);
    }
    close() {
      this.readyState = 3;
    }
  }

  class MockImage {
    width = 1280;
    height = 800;
    onload?: () => void;
    onerror?: () => void;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  const NativeURL = URL;
  class WrappedURL extends NativeURL {
    static override createObjectURL() { return "blob:mock"; }
    static override revokeObjectURL() {}
  }

  const mockFetch = async (path: string, init?: RequestInit) => {
    fetchCalls.push({ path, init });
    const handled = options.fetchHandler?.(path, init);
    if (handled) {
      const status = handled.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => handled.body ?? {},
      };
    }
    if (path === "/api/browser/status") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          enabled: true,
          running: false,
          viewerPath: "/browser",
          tabsCount: 1,
          activeTabId: "tab-1",
          viewport: { preset: "desktop", width: 1280, height: 800, mobile: false },
          pendingUploadsCount: 0,
          downloadsCount: 0,
          handoff: null,
        }),
      };
    }
    if (path === "/api/browser/tabs") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tabs: [{ id: "tab-1", title: "Home", url: "https://example.test/", active: true, loading: false }],
        }),
      };
    }
    if (path === "/api/browser/ws-ticket") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ticket: "ws-ticket-1", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const windowListeners = new Map<string, Array<() => void>>();
  const doc = {
    getElementById: (id: string) => ensureEl(id),
    createElement: (tag: string) => new MockElement(tag),
    activeElement: null,
    body: new MockElement("body"),
  };

  runInNewContext(extractScript(), {
    document: doc,
    window: {
      innerWidth: options.innerWidth ?? 1280,
      innerHeight: options.innerHeight ?? 800,
      addEventListener: (event: string, fn: () => void) => {
        const list = windowListeners.get(event) ?? [];
        list.push(fn);
        windowListeners.set(event, list);
      },
      confirm: () => true,
    },
    location,
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, nextUrl: string) {
        replacedUrls.push(nextUrl);
      },
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, val: string) => storage.set(key, val),
      removeItem: (key: string) => storage.delete(key),
    },
    fetch: mockFetch,
    WebSocket: MockWebSocket,
    Image: MockImage,
    Blob: class { constructor(public parts: unknown[], public opts?: unknown) {} },
    URL: WrappedURL,
    KeyboardEvent: class { constructor(public type: string, public init: Record<string, unknown>) { Object.assign(this, init); } },
    TextDecoder,
    performance: { now: () => 1000 },
    setTimeout,
    clearTimeout,
    atob,
    btoa,
  });

  return { elements, replacedUrls, fetchCalls, sockets };
};

test("browser viewer strips URL key params, supports silent cookie boot and fallback login modal", async () => {
  const { elements, replacedUrls, sockets } = setupViewerHarness({
    href: "http://127.0.0.1:12330/browser?accessKey=secret&foo=bar#hash",
  });
  await flush();
  assert.deepEqual(replacedUrls, ["/browser?foo=bar#hash"]);
  assert.equal(elements.get("loginModal")!.hidden, true);
  assert.equal(sockets.length, 1);

  // When unauthenticated and empty accessKey is rejected, shows login modal and authenticates via POST /api/session
  let authed = false;
  const authHarness = setupViewerHarness({
    fetchHandler: (path, init) => {
      if (path === "/api/browser/status") {
        if (!authed) return { status: 401, body: { error: "Unauthorized" } };
        return {
          status: 200,
          body: {
            enabled: true,
            running: true,
            viewerPath: "/browser",
            tabsCount: 1,
            activeTabId: "tab-1",
            viewport: { preset: "desktop", width: 1280, height: 800, mobile: false },
            pendingUploadsCount: 0,
            downloadsCount: 0,
            handoff: null,
          },
        };
      }
      if (path === "/api/session") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { accessKey?: string };
        if (body.accessKey === "correct-key") {
          authed = true;
          return { status: 200, body: { token: "tok-123" } };
        }
        return { status: 401, body: { error: "Invalid key" } };
      }
      return undefined as never;
    },
  });
  await flush();
  assert.equal(authHarness.elements.get("loginModal")!.hidden, false);
  authHarness.elements.get("accessKey")!.value = "correct-key";
  await authHarness.elements.get("login")!.onsubmit?.({ preventDefault() {} });
  await flush();
  assert.equal(authHarness.elements.get("loginModal")!.hidden, true);
  assert.equal(authHarness.elements.get("accessKey")!.value, "");
  assert.equal(authHarness.sockets.length, 1);
});

test("browser viewer sends frame_ack with sessionId (not piSessionId) for rendered and inactive frames", async () => {
  const { sockets } = setupViewerHarness();
  await flush();
  const ws = sockets[0]!;
  ws.onmessage?.({
    data: JSON.stringify({
      type: "ready",
      tabs: [{ id: "tab-1", title: "Home", url: "https://example.test/", active: true, loading: false }],
      activeTabId: "tab-1",
      viewport: { preset: "desktop", width: 1280, height: 800, mobile: false },
      files: { uploads: [], downloads: [] },
      handoff: null,
      frameFormat: "binary",
    }),
  });

  ws.onmessage?.({
    data: encodeBinaryFrame({
      tabId: "tab-1",
      frameId: 1,
      sessionId: "cast-sess-1",
      width: 1280,
      height: 800,
      timestamp: 1,
    }),
  });
  // Inactive tab frame should also ack cleanly with its sessionId
  ws.onmessage?.({
    data: encodeBinaryFrame({
      tabId: "tab-other",
      frameId: 2,
      sessionId: "cast-sess-2",
      width: 1280,
      height: 800,
      timestamp: 2,
    }),
  });
  await flush();

  const acks = ws.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((msg) => msg.type === "frame_ack");
  assert.deepEqual(acks, [
    { type: "frame_ack", frameId: 2, sessionId: "cast-sess-2" },
    { type: "frame_ack", frameId: 1, sessionId: "cast-sess-1" },
  ]);
  for (const ack of acks) {
    assert.equal("piSessionId" in ack, false);
  }
});

test("browser viewer auto-switches mobile viewport on narrow screen, maps touch gestures & IME input, and updates realtime banners", async () => {
  const { elements, fetchCalls, sockets } = setupViewerHarness({
    innerWidth: 390,
    innerHeight: 844,
    stageWidth: 390,
    stageHeight: 700,
    canvasWidth: 390,
    canvasHeight: 700,
  });
  await flush();
  const ws = sockets[0]!;
  ws.onmessage?.({
    data: JSON.stringify({
      type: "ready",
      tabs: [{ id: "tab-1", title: "Mobile", url: "https://example.test/", active: true, loading: false }],
      activeTabId: "tab-1",
      viewport: { preset: "desktop", width: 1280, height: 800, mobile: false },
      files: { uploads: [], downloads: [] },
      handoff: null,
      frameFormat: "binary",
    }),
  });

  const autoVp = ws.sent.map((s) => JSON.parse(s)).find((m) => m.type === "viewport");
  assert.deepEqual(autoVp, { type: "viewport", preset: "mobile", width: 390, height: 700, mobile: true });

  // Simulate server viewport confirmation + frame metadata for coordinate mapping
  ws.onmessage?.({
    data: JSON.stringify({
      type: "viewport",
      viewport: { preset: "mobile", width: 390, height: 700, mobile: true },
    }),
  });
  ws.onmessage?.({
    data: encodeBinaryFrame({
      tabId: "tab-1",
      frameId: 10,
      sessionId: "cast-mob",
      width: 390,
      height: 700,
      timestamp: 10,
    }),
  });
  await flush();
  ws.sent.length = 0;

  const keyboard = elements.get("keyboard")!;
  // 1. Short touch tap -> click at mapped coordinate
  keyboard.onpointerdown?.({ pointerType: "touch", pointerId: 1, clientX: 120, clientY: 200, preventDefault() {} });
  keyboard.onpointerup?.({ pointerType: "touch", pointerId: 1, clientX: 121, clientY: 201 });
  // 2. Touch drag in scroll mode -> wheel scroll
  keyboard.onpointerdown?.({ pointerType: "touch", pointerId: 2, clientX: 150, clientY: 300, preventDefault() {} });
  keyboard.onpointermove?.({ pointerType: "touch", pointerId: 2, clientX: 150, clientY: 240 });
  keyboard.onpointerup?.({ pointerType: "touch", pointerId: 2, clientX: 150, clientY: 240 });
  // 3. Switch gesture mode to drag -> emits pointer_down / pointer_move / pointer_up
  elements.get("gestureToggle")!.click();
  keyboard.onpointerdown?.({ pointerType: "touch", pointerId: 3, clientX: 50, clientY: 50, preventDefault() {} });
  keyboard.onpointermove?.({ pointerType: "touch", pointerId: 3, clientX: 80, clientY: 60 });
  keyboard.onpointerup?.({ pointerType: "touch", pointerId: 3, clientX: 80, clientY: 60 });
  // 4. Native input bar sends Chinese text cleanly
  elements.get("textInput")!.value = "你好世界";
  elements.get("textSend")!.click();

  const sent = ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  assert.ok(sent.some((m) => m.type === "click" && Math.round(Number(m.x)) === 121));
  assert.ok(sent.some((m) => m.type === "wheel" && Number(m.deltaY) > 0));
  assert.ok(sent.some((m) => m.type === "pointer_down") && sent.some((m) => m.type === "pointer_up"));
  assert.ok(sent.some((m) => m.type === "insert_text" && m.text === "你好世界"));
  assert.equal(elements.get("textInput")!.value, "");

  // 5. Real-time WS files & handoff notifications without polling
  ws.onmessage?.({
    data: JSON.stringify({
      type: "files",
      uploads: [{ id: "up-1", tabId: "tab-1", multiple: false, accept: ".png", createdAt: new Date().toISOString() }],
      downloads: [],
    }),
  });
  assert.equal(elements.get("uploadPrompt")!.hidden, false);
  assert.equal(elements.get("filesBadge")!.textContent, "1");

  ws.onmessage?.({
    data: JSON.stringify({
      type: "handoff",
      handoff: { id: "h-1", tabId: "tab-1", reason: "请扫码登录", url: "https://example.test/login", createdAt: new Date().toISOString() },
    }),
  });
  assert.equal(elements.get("handoffBanner")!.hidden, false);
  assert.match(elements.get("handoffReason")!.textContent, /请扫码登录/);

  await elements.get("handoffDone")!.click();
  await flush();
  assert.ok(fetchCalls.some((c) => c.path === "/api/browser/handoff" && c.init?.method === "DELETE"));
  assert.equal(elements.get("handoffBanner")!.hidden, true);
});
