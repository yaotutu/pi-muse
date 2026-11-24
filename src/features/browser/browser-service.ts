import { randomUUID } from "node:crypto";
import {
  BrowserError,
  type BrowserActInput,
  type BrowserActStepResult,
  type BrowserDownloadContent,
  type BrowserDownloadStore,
  type BrowserDriver,
  type BrowserFrame,
  type BrowserHandoff,
  type BrowserInputEvent,
  type BrowserScreenshot,
  type BrowserSnapshot,
  type BrowserStatus,
  type BrowserStreamClient,
  type BrowserTab,
  type BrowserUpdateScope,
  type BrowserUploadFile,
  type BrowserViewport,
  type BrowserViewportInput,
  type BrowserViewportPreset,
  type BrowserWaitInput,
} from "./types.js";
import { decodeBrowserUploadFiles } from "./files.js";

type Ticket = { value: string; expiresAt: number };
type ViewerSession = { id: string; expiresAt: number; timer: NodeJS.Timeout };
type ClientState = {
  client: BrowserStreamClient;
  ready: boolean;
  pendingFrame?: { frameId: number; sessionId: string; tabId: string };
};

/**
 * 一次性票据有效期：覆盖用户拿到链接后从容打开（手机端可能还要切网络、唤起输入法），
 * 同时保持“一次性 + 短时”语义，避免长期凭据沉在 URL 里。
 */
const TICKET_LIFETIME_MS = 600_000;
const VIEWER_SESSION_TTL_MS = 3_600_000;
const VIEWER_SESSION_MAX_AGE_SECONDS = 3600;
const MAX_CLIENT_BUFFER_BYTES = 2 * 1024 * 1024;
const VIEWPORT_MIN_PX = 320;
const VIEWPORT_MAX_PX = 2560;
const DEFAULT_DESKTOP_VIEWPORT: BrowserViewport = {
  preset: "desktop",
  width: 1280,
  height: 800,
  mobile: false,
};
const DEFAULT_MOBILE_VIEWPORT: BrowserViewport = {
  preset: "mobile",
  width: 390,
  height: 720,
  mobile: true,
};

const textEncoder = new TextEncoder();
const isFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const coordinate = (value: unknown) => isFinite(value) && value >= 0 && value <= 20000;
const scrollDelta = (value: unknown) => isFinite(value) && Math.abs(value) <= 100000;
const key = (value: unknown) =>
  typeof value === "string" && value.length <= 64 && /^[a-zA-Z0-9]+(?:\+[a-zA-Z0-9]+)*$/.test(value);
const button = (value: unknown) => value === undefined || ["left", "middle", "right"].includes(value as string);
const clickCount = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 3);
const isViewportDimension = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= VIEWPORT_MIN_PX && value <= VIEWPORT_MAX_PX;

export const normalizeBrowserViewport = (input: BrowserViewportInput): BrowserViewport => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BrowserError("INVALID_INPUT", "Invalid viewport payload");
  }
  const preset = input.preset;
  if (preset !== "desktop" && preset !== "mobile" && preset !== "custom") {
    throw new BrowserError("INVALID_INPUT", "viewport preset must be desktop, mobile, or custom");
  }
  if (input.mobile !== undefined && typeof input.mobile !== "boolean") {
    throw new BrowserError("INVALID_INPUT", "viewport mobile must be a boolean");
  }
  if (input.width !== undefined && !isViewportDimension(input.width)) {
    throw new BrowserError("INVALID_INPUT", `viewport width must be an integer between ${VIEWPORT_MIN_PX} and ${VIEWPORT_MAX_PX}`);
  }
  if (input.height !== undefined && !isViewportDimension(input.height)) {
    throw new BrowserError("INVALID_INPUT", `viewport height must be an integer between ${VIEWPORT_MIN_PX} and ${VIEWPORT_MAX_PX}`);
  }
  if (preset === "custom") {
    if (input.width === undefined || input.height === undefined) {
      throw new BrowserError("INVALID_INPUT", "custom viewport requires width and height");
    }
    return {
      preset: "custom",
      width: input.width,
      height: input.height,
      mobile: input.mobile ?? input.width <= 640,
    };
  }
  const defaults = preset === "mobile" ? DEFAULT_MOBILE_VIEWPORT : DEFAULT_DESKTOP_VIEWPORT;
  return {
    preset,
    width: input.width ?? defaults.width,
    height: input.height ?? defaults.height,
    mobile: input.mobile ?? defaults.mobile,
  };
};

/** feature 层不用协议库；这里保持与 HTTP 契约相同的输入边界。 */
const isInputMessage = (value: unknown): value is BrowserInputEvent => {
  const item = value as Record<string, unknown>;
  if (!item || typeof item !== "object") return false;
  switch (item.type) {
    case "pointer_move": case "pointer_down": case "pointer_up":
      return coordinate(item.x) && coordinate(item.y) && button(item.button);
    case "click":
      return coordinate(item.x) && coordinate(item.y) && button(item.button) &&
        clickCount(item.clickCount);
    case "wheel":
      return (item.x === undefined || coordinate(item.x)) && (item.y === undefined || coordinate(item.y)) &&
        scrollDelta(item.deltaX) && scrollDelta(item.deltaY);
    case "key_down": case "key_up":
      return key(item.key);
    case "insert_text":
      return typeof item.text === "string" && item.text.length >= 1 && item.text.length <= 2000;
    default:
      return false;
  }
};

const tabsPayload = (tabs: BrowserTab[]) => {
  const active = tabs.find((tab) => tab.active) ?? tabs[0];
  return {
    type: "tabs",
    tabs,
    activeTabId: active?.id ?? null,
  };
};

const frameMessage = (frame: BrowserFrame) => {
  const metadata = {
    type: "frame",
    frameId: frame.frameId,
    tabId: frame.tabId,
    sessionId: frame.sessionId,
    width: frame.width,
    height: frame.height,
    mimeType: "image/jpeg",
    timestamp: frame.timestamp,
  };
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, metadataBytes.length, false);
  const output = new Uint8Array(header.length + metadataBytes.length + frame.jpeg.length);
  output.set(header, 0);
  output.set(metadataBytes, header.length);
  output.set(frame.jpeg, header.length + metadataBytes.length);
  return output;
};

/**
 * BrowserService 是浏览器能力的唯一业务入口：HTTP、/browser 操控页、WS 与 Agent 工具
 * 都操作同一个懒启动真实 GUI Chrome 实例。这里只保留标签、动态视口、实时文件状态、
 * 人工接管、一次性 ticket 和输入协议，不做恢复框架或多用户租约。
 */
export const createBrowserService = (
  driver: BrowserDriver,
  downloadStore: BrowserDownloadStore,
  options: { onStateChange?: (scope: BrowserUpdateScope, handoff?: BrowserHandoff | null) => void } = {},
) => {
  let closed = false;
  let closing: Promise<void> | undefined;
  const clients = new Map<BrowserStreamClient, ClientState>();
  const tickets = new Map<string, Ticket>();
  const viewerTickets = new Map<string, Ticket>();
  const viewerSessions = new Map<string, ViewerSession>();
  let lastKnownTabs: BrowserTab[] = [];
  let lastRunning = driver.isRunning();
  let activeTabId: string | undefined;
  let screencastTabId: string | undefined;
  let screencastSync: Promise<void> = Promise.resolve();
  let viewportTail: Promise<void> = Promise.resolve();
  let latestFrame: BrowserFrame | undefined;
  let inputTail: Promise<void> = Promise.resolve();
  let activeHandoff: BrowserHandoff | null = null;

  const checkOpen = () => {
    if (closed) throw new BrowserError("BROWSER_FAILED", "Browser service is closed");
  };

  const broadcastJson = (payload: object) => {
    const serialized = JSON.stringify(payload);
    for (const { client, ready } of clients.values()) {
      if (!ready) continue;
      try {
        client.sendText(serialized);
      } catch {
        client.close();
        detachClient(client);
      }
    }
  };

  const broadcastTabs = (tabs: BrowserTab[]) => {
    lastKnownTabs = tabs.map((tab) => ({ ...tab }));
    const previousTabId = activeTabId;
    activeTabId = (tabs.find((tab) => tab.active) ?? tabs[0])?.id;
    const message = JSON.stringify(tabsPayload(tabs));
    for (const { client, ready } of clients.values()) {
      if (!ready) continue;
      try {
        client.sendText(message);
      } catch {
        client.close();
        detachClient(client);
      }
    }
    return previousTabId !== activeTabId;
  };

  const clearHandoffIfTabMissing = (tabs: BrowserTab[]) => {
    if (!activeHandoff) return;
    if (tabs.some((tab) => tab.id === activeHandoff!.tabId)) return;
    activeHandoff = null;
    broadcastJson({ type: "handoff", handoff: null });
    options.onStateChange?.("handoff", null);
  };

  /**
   * screencast 的启停按队列串行执行，但每次执行时重新读取当前订阅和 active tab。
   * 这样快速切 tab、最后一个 viewer 离开后立刻重连时，不会被较早的异步 stop 覆盖。
   */
  const syncScreencast = () => {
    const pending = screencastSync.then(async () => {
      const nextTabId = clients.size ? activeTabId : undefined;
      if (screencastTabId === nextTabId) return;
      if (screencastTabId) await driver.stopScreencast(screencastTabId).catch(() => undefined);
      screencastTabId = undefined;
      if (!nextTabId) return;
      try {
        await driver.startScreencast(nextTabId);
        screencastTabId = nextTabId;
      } catch {
        // 启动失败时保留空状态，后续显式操作或标签变化可再次尝试。
      }
    });
    screencastSync = pending.catch(() => undefined);
    return pending;
  };

  const clearPendingFrames = () => {
    for (const state of clients.values()) state.pendingFrame = undefined;
  };

  const clearFrameState = () => {
    latestFrame = undefined;
    clearPendingFrames();
  };

  const sendFrame = (state: ClientState, frame: BrowserFrame, message?: Uint8Array) => {
    if (!state.ready || state.pendingFrame !== undefined) return;
    if (state.client.bufferedAmount() > MAX_CLIENT_BUFFER_BYTES) {
      state.client.close();
      detachClient(state.client);
      return;
    }
    try {
      state.client.sendBinary(message ?? frameMessage(frame));
      state.pendingFrame = { frameId: frame.frameId, sessionId: frame.sessionId, tabId: frame.tabId };
    } catch {
      state.client.close();
      detachClient(state.client);
    }
  };

  const filesSnapshot = async () => {
    const [uploads, downloads] = await Promise.all([
      driver.listUploads(),
      downloadStore.list(),
    ]);
    return { uploads, downloads };
  };

  const broadcastFiles = async () => {
    if (closed) return;
    try {
      const files = await filesSnapshot();
      if (closed) return;
      broadcastJson({ type: "files", ...files });
      options.onStateChange?.("files");
    } catch {
      // 文件快照异常不破坏下载或上传事件循环；HTTP GET 会暴露受控 500。
    }
  };

  driver.onTabsChanged?.((tabs) => {
    const prevRunning = lastRunning;
    const nowRunning = driver.isRunning();
    lastRunning = nowRunning;
    if (broadcastTabs(tabs)) clearFrameState();
    clearHandoffIfTabMissing(tabs);
    void syncScreencast();
    if (prevRunning !== nowRunning) options.onStateChange?.("lifecycle");
    else options.onStateChange?.("tabs");
  });

  driver.onFrame?.((frame) => {
    if (frame.tabId !== activeTabId) return;
    latestFrame = frame;
    const recipients = [...clients.values()].filter((state) =>
      state.ready && state.pendingFrame === undefined);
    if (!recipients.length) return;
    const message = frameMessage(frame);
    for (const state of recipients) sendFrame(state, frame, message);
  });

  driver.onDownload?.((download) => {
    if (closed) {
      void download.cancel().catch(() => undefined);
      void download.discard().catch(() => undefined);
      return;
    }
    void downloadStore.capture(download).catch(() => undefined);
  });

  driver.onUploadsChanged?.(() => {
    void broadcastFiles();
  });

  downloadStore.onChanged?.(() => {
    void broadcastFiles();
  });

  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    checkOpen();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("BROWSER_FAILED", "Browser operation failed");
    }
  };

  const runFiles = async <T>(operation: () => Promise<T>): Promise<T> => {
    checkOpen();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError("BROWSER_FAILED", "Browser files operation failed");
    }
  };

  const listTabs = () => run(async () => {
    const prevRunning = lastRunning;
    const tabs = await driver.listTabs();
    lastRunning = driver.isRunning();
    if (broadcastTabs(tabs)) {
      clearFrameState();
      void syncScreencast();
    }
    clearHandoffIfTabMissing(tabs);
    if (prevRunning !== lastRunning) options.onStateChange?.("lifecycle");
    return tabs;
  });

  const withActiveTab = async () => {
    const tabs = await listTabs();
    const active = tabs.find((tab) => tab.active) ?? tabs[0];
    if (!active) throw new BrowserError("TAB_NOT_FOUND", "No browser tab is open");
    return active;
  };

  const resolveTabId = async (tabId?: string) => {
    if (!tabId) return (await withActiveTab()).id;
    const tabs = await listTabs();
    if (!tabs.some((tab) => tab.id === tabId)) {
      throw new BrowserError("TAB_NOT_FOUND", "Browser tab not found");
    }
    return tabId;
  };

  const createTicket = () => {
    checkOpen();
    const now = Date.now();
    for (const [id, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(id);
    const ticket: Ticket = {
      value: randomUUID(),
      expiresAt: now + TICKET_LIFETIME_MS,
    };
    tickets.set(ticket.value, ticket);
    return { ticket: ticket.value, expiresAt: new Date(ticket.expiresAt).toISOString() };
  };

  const consumeTicket = (value: string | undefined) => {
    checkOpen();
    const ticket = value ? tickets.get(value) : undefined;
    tickets.delete(value ?? "");
    return Boolean(ticket && ticket.expiresAt > Date.now());
  };

  const createViewerTicket = () => {
    checkOpen();
    const now = Date.now();
    for (const [id, ticket] of viewerTickets) if (ticket.expiresAt <= now) viewerTickets.delete(id);
    const ticket: Ticket = {
      value: randomUUID(),
      expiresAt: now + TICKET_LIFETIME_MS,
    };
    viewerTickets.set(ticket.value, ticket);
    return {
      launchPath: `/browser/launch?ticket=${ticket.value}`,
      expiresAt: new Date(ticket.expiresAt).toISOString(),
    };
  };

  const consumeViewerTicket = (value: string | undefined) => {
    checkOpen();
    const ticket = value ? viewerTickets.get(value) : undefined;
    if (value) viewerTickets.delete(value);
    if (!ticket || ticket.expiresAt <= Date.now()) return undefined;
    const id = randomUUID();
    const session: ViewerSession = {
      id,
      expiresAt: Date.now() + VIEWER_SESSION_TTL_MS,
      timer: setTimeout(() => viewerSessions.delete(id), VIEWER_SESSION_TTL_MS),
    };
    session.timer.unref();
    viewerSessions.set(id, session);
    return { sessionId: id, maxAgeSeconds: VIEWER_SESSION_MAX_AGE_SECONDS };
  };

  const hasViewerSession = (sessionId: string | undefined) => {
    if (closed || !sessionId) return false;
    const session = viewerSessions.get(sessionId);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      clearTimeout(session.timer);
      viewerSessions.delete(sessionId);
      return false;
    }
    return true;
  };

  const setViewport = (input: BrowserViewportInput): Promise<BrowserViewport> =>
    run(async () => {
      const normalized = normalizeBrowserViewport(input);
      const pending = viewportTail.then(async () => {
        checkOpen();
        clearFrameState();
        const applied = await driver.setViewport(normalized);
        broadcastJson({ type: "viewport", viewport: applied });
        options.onStateChange?.("viewport");
        return applied;
      });
      viewportTail = pending.then(() => undefined, () => undefined);
      return pending;
    });

  const status = (): Promise<BrowserStatus> => runFiles(async () => {
    const running = driver.isRunning();
    const [uploads, downloads] = await Promise.all([
      running ? driver.listUploads() : Promise.resolve([]),
      downloadStore.list(),
    ]);
    const tabs = running ? lastKnownTabs : [];
    const currentActiveId = running
      ? (activeTabId ?? (tabs.find((tab) => tab.active) ?? tabs[0])?.id ?? null)
      : null;
    return {
      enabled: true,
      running,
      viewerPath: "/browser",
      tabsCount: tabs.length,
      activeTabId: currentActiveId,
      viewport: driver.getViewport(),
      pendingUploadsCount: uploads.length,
      downloadsCount: downloads.length,
      handoff: activeHandoff ? { ...activeHandoff } : null,
    };
  });

  const requestHandoff = (tabId: string | undefined, rawReason: string) =>
    run(async () => {
      const reason = typeof rawReason === "string" ? rawReason.trim() : "";
      if (!reason || reason.length > 300) {
        throw new BrowserError("INVALID_INPUT", "handoff reason must be 1-300 characters");
      }
      const targetTabId = await resolveTabId(tabId);
      const targetTab = lastKnownTabs.find((item) => item.id === targetTabId);
      if (!targetTab) {
        throw new BrowserError("TAB_NOT_FOUND", "Browser tab not found");
      }
      const handoff: BrowserHandoff = {
        id: randomUUID(),
        tabId: targetTab.id,
        reason,
        url: targetTab.url,
        createdAt: new Date().toISOString(),
      };
      activeHandoff = handoff;
      broadcastJson({ type: "handoff", handoff });
      options.onStateChange?.("handoff", handoff);
      return { ...handoff };
    });

  const resolveHandoff = () => {
    checkOpen();
    const hadHandoff = activeHandoff !== null;
    activeHandoff = null;
    if (hadHandoff) {
      broadcastJson({ type: "handoff", handoff: null });
      options.onStateChange?.("handoff", null);
    }
    return { ok: true as const };
  };

  const detachClient = (client: BrowserStreamClient) => {
    if (!clients.delete(client)) return;
    void syncScreencast();
  };

  const sendClientError = (client: BrowserStreamClient, error: string) => {
    if (!clients.has(client)) return;
    try {
      client.sendText(JSON.stringify({ type: "error", error }));
    } catch {
      client.close();
      detachClient(client);
    }
  };

  /**
   * WS 输入共享同一个 Chrome，必须按收到顺序串行执行。这里只串行已校验的
   * driver.input；ack、ready 与帧推送保持独立，不被慢输入阻塞。
   */
  const enqueueInput = (client: BrowserStreamClient, tabId: string, input: BrowserInputEvent) => {
    const pending = inputTail.then(async () => {
      try {
        await driver.input(tabId, input);
      } catch {
        sendClientError(client, "Browser input failed");
      }
    });
    inputTail = pending.catch(() => undefined);
  };

  const handleClientMessage = (client: BrowserStreamClient, raw: string) => {
    const state = clients.get(client);
    if (!state?.ready) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      sendClientError(client, "Invalid JSON message");
      return;
    }
    const value = message as {
      type?: unknown;
      frameId?: unknown;
      sessionId?: unknown;
      preset?: unknown;
      width?: unknown;
      height?: unknown;
      mobile?: unknown;
    };
    if (value?.type === "frame_ack") {
      if (
        typeof value.frameId !== "number" ||
        typeof value.sessionId !== "string" ||
        state.pendingFrame?.frameId !== value.frameId ||
        state.pendingFrame.sessionId !== value.sessionId
      ) return;
      state.pendingFrame = undefined;
      return;
    }
    if (value?.type === "viewport") {
      let nextViewport: BrowserViewport;
      try {
        nextViewport = normalizeBrowserViewport({
          preset: value.preset as BrowserViewportPreset,
          width: value.width as number | undefined,
          height: value.height as number | undefined,
          mobile: value.mobile as boolean | undefined,
        });
      } catch (caught) {
        sendClientError(client, caught instanceof BrowserError ? caught.message : "Invalid viewport message");
        return;
      }
      void setViewport(nextViewport).catch(() => {
        sendClientError(client, "Browser viewport update failed");
      });
      return;
    }
    if (!isInputMessage(message)) {
      sendClientError(client, "Invalid input message");
      return;
    }
    // 绑定消息到达时的标签；输入排队后不能因后续切换标签而改写到新标签。
    const targetTabId = activeTabId;
    if (!targetTabId) {
      sendClientError(client, "No active browser tab");
      return;
    }
    enqueueInput(client, targetTabId, message);
  };

  const attachClient = (client: BrowserStreamClient) => {
    checkOpen();
    clients.set(client, { client, ready: false });
    void (async () => {
      try {
        const [tabs, files] = await Promise.all([
          driver.listTabs(),
          filesSnapshot(),
        ]);
        if (!clients.has(client)) return;
        const prevRunning = lastRunning;
        lastRunning = driver.isRunning();
        if (broadcastTabs(tabs)) clearFrameState();
        clearHandoffIfTabMissing(tabs);
        if (prevRunning !== lastRunning) options.onStateChange?.("lifecycle");
        if (!clients.has(client)) return;
        client.sendText(JSON.stringify({
          type: "ready",
          tabs,
          activeTabId: activeTabId ?? null,
          viewport: driver.getViewport(),
          files,
          handoff: activeHandoff,
          frameFormat: BROWSER_FRAME_FORMAT,
        }));
        const state = clients.get(client);
        if (!state) return;
        state.ready = true;
        const cachedFrame = latestFrame;
        if (cachedFrame && cachedFrame.tabId === activeTabId) sendFrame(state, cachedFrame);
        await syncScreencast();
      } catch {
        if (!clients.has(client)) return;
        client.sendText(JSON.stringify({ type: "error", error: "Browser operation failed" }));
        client.close();
        detachClient(client);
      }
    })();
    return {
      handleMessage: (message: string) => {
        handleClientMessage(client, message);
      },
      detach: () => detachClient(client),
    };
  };

  const close = () => {
    if (closing) return closing;
    closed = true;
    for (const { client } of clients.values()) client.close();
    clients.clear();
    tickets.clear();
    viewerTickets.clear();
    for (const session of viewerSessions.values()) clearTimeout(session.timer);
    viewerSessions.clear();
    latestFrame = undefined;
    lastKnownTabs = [];
    activeTabId = undefined;
    activeHandoff = null;
    lastRunning = false;
    closing = (async () => {
      await screencastSync.catch(() => undefined);
      await viewportTail.catch(() => undefined);
      await inputTail.catch(() => undefined);
      await downloadStore.close().catch(() => undefined);
      await driver.close().catch(() => undefined);
    })();
    return closing;
  };

  return {
    status,
    listTabs,
    newTab: (url?: string) => run(() => driver.newTab(url)),
    closeTab: (tabId: string) => run(() => driver.closeTab(tabId)),
    activateTab: (tabId: string) => run(() => driver.activateTab(tabId)),
    navigate: (tabId: string | undefined, url: string) =>
      run(async () => {
        const target = tabId ?? (await withActiveTab()).id;
        return driver.navigate(target, url);
      }),
    history: (tabId: string | undefined, action: "back" | "forward") =>
      run(async () => {
        const target = tabId ?? (await withActiveTab()).id;
        return driver.history(target, action);
      }),
    reload: (tabId: string | undefined) =>
      run(async () => {
        const target = tabId ?? (await withActiveTab()).id;
        return driver.reload(target);
      }),
    getViewport: () => driver.getViewport(),
    setViewport,
    input: (tabId: string, event: BrowserInputEvent) => run(() => driver.input(tabId, event)),
    act: (tabId: string | undefined, input: BrowserActInput) =>
      run(async () => {
        const target = await resolveTabId(tabId);
        if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 20)
          throw new BrowserError("INVALID_INPUT", "act requires 1-20 steps");
        const results: BrowserActStepResult[] = [];
        for (const [index, step] of input.steps.entries()) {
          try {
            await driver.act(target, step);
            results.push({ index, action: step.action, ok: true });
          } catch (error) {
            results.push({
              index,
              action: step.action,
              ok: false,
              code: error instanceof BrowserError ? error.code : "BROWSER_FAILED",
              error: error instanceof BrowserError ? error.message : "Browser operation failed",
            });
            break;
          }
        }
        const snapshot = { ...(await driver.snapshot(target)), untrusted: true as const };
        return { ok: results.every((result) => result.ok), results, snapshot };
      }),
    snapshot: (tabId?: string) =>
      run(async () => {
        const target = await resolveTabId(tabId);
        const snapshot = await driver.snapshot(target);
        return { ...snapshot, untrusted: true } satisfies BrowserSnapshot;
      }),
    screenshot: (tabId?: string): Promise<BrowserScreenshot> =>
      run(async () => {
        const target = await resolveTabId(tabId);
        const shot = await driver.screenshot(target);
        return { ...shot, untrusted: true };
      }),
    wait: (tabId: string | undefined, input: BrowserWaitInput) =>
      run(async () => {
        if (input.timeoutMs !== undefined && (!isFinite(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 30_000)) {
          throw new BrowserError("INVALID_INPUT", "wait timeoutMs must be between 100 and 30000");
        }
        if (input.loadState !== undefined && input.loadState !== "domcontentloaded" && input.loadState !== "load") {
          throw new BrowserError("INVALID_INPUT", "wait loadState must be domcontentloaded or load");
        }
        const target = await resolveTabId(tabId);
        return driver.wait(target, input);
      }),
    requestHandoff,
    resolveHandoff,
    listFiles: () => runFiles(filesSnapshot),
    uploadFiles: (
      uploadId: string,
      files: readonly { name: string; mimeType: string; contentBase64: string }[],
    ) => runFiles(async () => {
      const upload = (await driver.listUploads()).find((item) => item.id === uploadId);
      if (!upload) throw new BrowserError("UPLOAD_NOT_FOUND", "Browser upload chooser not found");
      const decoded: BrowserUploadFile[] = decodeBrowserUploadFiles(upload, files);
      await driver.setUploadFiles(uploadId, decoded);
      await broadcastFiles();
      return { ok: true as const };
    }),
    cancelUpload: (uploadId: string) => runFiles(async () => {
      await driver.cancelUpload(uploadId);
      await broadcastFiles();
      return { ok: true as const };
    }),
    downloadContent: (downloadId: string): Promise<BrowserDownloadContent> =>
      runFiles(() => downloadStore.content(downloadId)),
    deleteDownload: (downloadId: string) => runFiles(async () => {
      await downloadStore.remove(downloadId);
      return { ok: true as const };
    }),
    createTicket,
    consumeTicket,
    createViewerTicket,
    consumeViewerTicket,
    hasViewerSession,
    attachClient,
    close,
  };
};

export type BrowserService = ReturnType<typeof createBrowserService>;

/** WS 二进制帧：4 字节大端 metadata 长度 + UTF-8 JSON metadata + JPEG 字节。 */
export const BROWSER_FRAME_FORMAT =
  "binary: uint32be metadataLength + utf8-json metadata + jpeg bytes";
