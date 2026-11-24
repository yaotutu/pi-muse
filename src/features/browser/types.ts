/** 浏览器域的受控错误；HTTP 与 pi 工具层都只透出这里的稳定 code/message。 */
export class BrowserError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "TAB_NOT_FOUND"
      | "UPLOAD_NOT_FOUND"
      | "DOWNLOAD_NOT_FOUND"
      | "DOWNLOAD_NOT_READY"
      | "HANDOFF_NOT_FOUND"
      | "PAYLOAD_TOO_LARGE"
      | "STALE_REF"
      | "BROWSER_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}

export type BrowserViewportPreset = "desktop" | "mobile" | "custom";

export type BrowserViewport = {
  preset: BrowserViewportPreset;
  width: number;
  height: number;
  mobile: boolean;
};

export type BrowserViewportInput = {
  preset: BrowserViewportPreset;
  width?: number;
  height?: number;
  mobile?: boolean;
};

export type BrowserTab = {
  id: string;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
};

export type BrowserSnapshot = {
  tab: BrowserTab;
  untrusted: true;
  title: string;
  url: string;
  tree: string;
  text: string;
  truncated: boolean;
};

export type BrowserScreenshot = {
  tab: BrowserTab;
  untrusted: true;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  dataBase64: string;
};

export type BrowserHandoff = {
  id: string;
  tabId: string;
  reason: string;
  url: string;
  createdAt: string;
};

export type BrowserUpdateScope =
  | "tabs"
  | "viewport"
  | "files"
  | "handoff"
  | "lifecycle";

export type BrowserStatus = {
  enabled: boolean;
  running: boolean;
  viewerPath: string | null;
  tabsCount: number;
  activeTabId: string | null;
  viewport: BrowserViewport;
  pendingUploadsCount: number;
  downloadsCount: number;
  handoff: BrowserHandoff | null;
};

export type BrowserFrame = {
  tabId: string;
  frameId: number;
  sessionId: string;
  width: number;
  height: number;
  timestamp: number;
  jpeg: Uint8Array;
};

export type BrowserInputEvent =
  | { type: "pointer_move"; x: number; y: number }
  | { type: "pointer_down"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { type: "pointer_up"; x: number; y: number; button?: "left" | "middle" | "right" }
  | { type: "click"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number }
  | { type: "wheel"; x?: number; y?: number; deltaX: number; deltaY: number }
  | { type: "key_down"; key: string }
  | { type: "key_up"; key: string }
  | { type: "insert_text"; text: string };

export type BrowserActStep = {
  action: "click" | "type" | "press" | "scroll" | "hover" | "select";
  ref?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  value?: string;
  label?: string;
};

export type BrowserActInput = { steps: BrowserActStep[] };

export type BrowserActStepResult = {
  index: number;
  action: BrowserActStep["action"];
  ok: boolean;
  code?: BrowserError["code"];
  error?: string;
};

export type BrowserWaitInput = {
  text?: string;
  ref?: string;
  loadState?: "domcontentloaded" | "load";
  timeoutMs?: number;
};

export type BrowserUpload = {
  id: string;
  tabId: string;
  multiple: boolean;
  accept: string;
  createdAt: string;
};

export type BrowserUploadFile = {
  name: string;
  mimeType: string;
  content: Uint8Array;
};

export type BrowserDownloadStatus = "downloading" | "completed" | "failed";

export type BrowserDownload = {
  id: string;
  tabId: string;
  name: string;
  status: BrowserDownloadStatus;
  bytes: number | null;
  createdAt: string;
  error: string | null;
};

export type BrowserDownloadContent = {
  name: string;
  mimeType: string;
  contentBase64: string;
};

/**
 * Playwright download 事件交给 feature/store 的最小句柄。
 * 只暴露可读字节与取消/清理动作，不把本地路径或 Playwright 对象泄漏到 HTTP。
 */
export type BrowserDownloadEvent = {
  id: string;
  tabId: string;
  name: string;
  createdAt: string;
  read: () => Promise<AsyncIterable<Uint8Array>>;
  failure: () => Promise<string | null>;
  cancel: () => Promise<void>;
  discard: () => Promise<void>;
};

export type BrowserDownloadStore = {
  reconcileOnStart: () => Promise<void>;
  list: () => Promise<BrowserDownload[]>;
  capture: (download: BrowserDownloadEvent) => Promise<void>;
  content: (downloadId: string) => Promise<BrowserDownloadContent>;
  remove: (downloadId: string) => Promise<void>;
  close: () => Promise<void>;
  onChanged?: (listener: () => void) => void;
};

/** 驱动层只描述能力，不感知 HTTP、WS、pi 或配置文件。 */
export type BrowserDriver = {
  start: () => Promise<void>;
  close: () => Promise<void>;
  isRunning: () => boolean;
  listTabs: () => Promise<BrowserTab[]>;
  newTab: (url?: string) => Promise<BrowserTab>;
  closeTab: (tabId: string) => Promise<BrowserTab[]>;
  activateTab: (tabId: string) => Promise<BrowserTab>;
  navigate: (tabId: string, url: string) => Promise<BrowserTab>;
  history: (tabId: string, action: "back" | "forward") => Promise<BrowserTab>;
  reload: (tabId: string) => Promise<BrowserTab>;
  getViewport: () => BrowserViewport;
  setViewport: (viewport: BrowserViewport) => Promise<BrowserViewport>;
  input: (tabId: string, event: BrowserInputEvent) => Promise<void>;
  act: (tabId: string, step: BrowserActStep) => Promise<void>;
  snapshot: (tabId: string) => Promise<Omit<BrowserSnapshot, "untrusted">>;
  screenshot: (tabId: string) => Promise<Omit<BrowserScreenshot, "untrusted">>;
  wait: (tabId: string, input: BrowserWaitInput) => Promise<{ ok: boolean; waited: string }>;
  startScreencast: (tabId: string) => Promise<void>;
  stopScreencast: (tabId: string) => Promise<void>;
  listUploads: () => Promise<BrowserUpload[]>;
  setUploadFiles: (uploadId: string, files: BrowserUploadFile[]) => Promise<void>;
  cancelUpload: (uploadId: string) => Promise<void>;
  onTabsChanged?: (listener: (tabs: BrowserTab[]) => void) => void;
  onFrame?: (listener: (frame: BrowserFrame) => void) => void;
  onDownload?: (listener: (download: BrowserDownloadEvent) => void) => void;
  onUploadsChanged?: (listener: () => void) => void;
};

/** WS 适配层只需提供最小发送/关闭能力；协议语义留在 BrowserService。 */
export type BrowserStreamClient = {
  sendText: (message: string) => void;
  sendBinary: (data: Uint8Array) => void;
  close: () => void;
  bufferedAmount: () => number;
};
