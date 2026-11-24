/** 服务端自带 /browser 响应式真实浏览器操控页：同时适配手机竖屏与桌面端。 */
export const browserViewerPage = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title>pi-muse browser</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0e1214;
      --panel: #171d20;
      --panel-2: #212a2e;
      --line: #303d42;
      --text: #eef4f4;
      --muted: #98aaad;
      --accent: #68dcaf;
      --accent-soft: rgba(104, 220, 175, 0.16);
      --warn: #f4b860;
      --danger: #ff8b78;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      height: 100%;
      width: 100%;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Avenir Next", "Segoe UI", sans-serif;
      -webkit-tap-highlight-color: transparent;
    }
    body {
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh;
      padding-top: env(safe-area-inset-top);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
    }
    input, button {
      border: 1px solid var(--line);
      background: #101517;
      color: var(--text);
      border-radius: 8px;
      padding: 7px 10px;
      font: inherit;
      font-size: 13px;
      min-height: 36px;
    }
    button {
      cursor: pointer;
      background: var(--panel-2);
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
    }
    button:disabled { cursor: not-allowed; opacity: .45; }
    button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
    button.danger:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 999px;
      background: var(--accent);
      color: #0b1411;
      font-size: 11px;
      font-weight: 700;
    }
    .badge[hidden] { display: none; }
    .toolbar {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 8px 10px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      flex-shrink: 0;
    }
    .toolbar input { flex: 1; min-width: 0; font-size: 14px; }
    .brand {
      font-weight: 700;
      font-size: 13px;
      letter-spacing: .03em;
      color: var(--accent);
      margin-right: 4px;
    }
    .tabs {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding: 6px 10px;
      background: #13181b;
      border-bottom: 1px solid var(--line);
      flex-shrink: 0;
    }
    .tab {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 5px 9px;
      background: #101517;
      color: var(--muted);
      font-size: 12px;
      cursor: pointer;
    }
    .tab.active {
      color: var(--text);
      border-color: var(--accent);
      box-shadow: inset 0 -2px 0 var(--accent);
    }
    .tab button {
      min-height: 20px;
      padding: 1px 5px;
      border: 0;
      background: transparent;
      color: inherit;
    }
    .banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 12px;
      font-size: 13px;
      border-bottom: 1px solid var(--line);
      flex-shrink: 0;
    }
    .banner[hidden] { display: none; }
    .banner-handoff {
      background: rgba(244, 184, 96, 0.14);
      border-bottom-color: rgba(244, 184, 96, 0.45);
      color: #ffe3b8;
    }
    .banner-upload {
      background: rgba(104, 220, 175, 0.12);
      border-bottom-color: rgba(104, 220, 175, 0.4);
      color: #d9fff0;
    }
    .banner-text { min-width: 0; flex: 1; overflow-wrap: anywhere; }
    .banner-btn-ok {
      border-color: var(--accent);
      background: var(--accent);
      color: #0b1411;
      font-weight: 600;
    }
    .banner-btn-ok:hover:not(:disabled) { color: #0b1411; opacity: .9; }
    .files-panel {
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      padding: 10px 12px;
      max-height: 36vh;
      overflow-y: auto;
      flex-shrink: 0;
    }
    .files-panel[hidden] { display: none; }
    .files-head, .file-row, .file-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .files-head { justify-content: space-between; }
    .files-head h2 { margin: 0; font-size: 14px; }
    .file-row { padding: 8px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
    .file-detail { flex: 1 1 200px; min-width: 0; color: var(--muted); font-size: 13px; }
    .file-actions { flex: 1 1 240px; }
    .file-actions input { width: min(100%, 260px); }
    .files-status { min-height: 20px; color: var(--muted); font-size: 12px; margin: 4px 0; }
    .stage {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      background: #050708;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    .viewport-wrap {
      position: absolute;
      inset: 0;
      transform-origin: 0 0;
      will-change: transform;
    }
    canvas, #keyboard {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    canvas { object-fit: contain; background: #050708; display: block; pointer-events: none; }
    #keyboard {
      opacity: 0;
      resize: none;
      border: 0;
      background: transparent;
      color: transparent;
      caret-color: transparent;
      touch-action: none;
      z-index: 2;
    }
    .status {
      position: absolute;
      left: 10px;
      bottom: 10px;
      z-index: 3;
      padding: 4px 8px;
      border-radius: 6px;
      background: rgba(14, 18, 20, .82);
      color: var(--muted);
      font-size: 11px;
      pointer-events: none;
    }
    .empty {
      position: absolute;
      inset: 0;
      z-index: 3;
      display: grid;
      place-items: center;
      color: var(--muted);
      pointer-events: none;
      text-align: center;
      padding: 20px;
      font-size: 14px;
    }
    .zoom-reset {
      position: absolute;
      right: 10px;
      bottom: 10px;
      z-index: 4;
      background: rgba(23, 29, 32, 0.92);
      border-color: var(--accent);
      color: var(--accent);
      font-size: 12px;
      min-height: 32px;
      padding: 4px 10px;
    }
    .zoom-reset[hidden] { display: none; }
    .tap-ripple {
      position: absolute;
      z-index: 4;
      width: 26px;
      height: 26px;
      margin: -13px 0 0 -13px;
      border-radius: 999px;
      border: 2px solid var(--accent);
      background: rgba(104, 220, 175, 0.2);
      pointer-events: none;
      opacity: 0;
      transition: transform 220ms ease-out, opacity 220ms ease-out;
    }
    .native-input-bar {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      padding: 8px 10px;
      background: var(--panel);
      border-top: 1px solid var(--line);
      flex-shrink: 0;
    }
    .native-input-bar[hidden] { display: none; }
    .native-input-bar input { flex: 1 1 160px; min-width: 0; font-size: 16px; }
    .mobile-bar {
      display: none;
      gap: 4px;
      align-items: center;
      padding: 6px 6px calc(6px + env(safe-area-inset-bottom));
      background: var(--panel);
      border-top: 1px solid var(--line);
      flex-shrink: 0;
    }
    .mobile-bar button {
      flex: 1;
      min-width: 0;
      min-height: 44px;
      padding: 4px 4px;
      font-size: 12px;
    }
    .tabs-sheet {
      position: fixed;
      inset: 0;
      z-index: 30;
      background: rgba(0, 0, 0, .55);
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    }
    .tabs-sheet[hidden] { display: none; }
    .tabs-sheet-card {
      background: var(--panel);
      border-top: 1px solid var(--line);
      border-radius: 16px 16px 0 0;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
      padding: 12px 12px calc(12px + env(safe-area-inset-bottom));
      gap: 8px;
    }
    .tabs-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .tabs-sheet-head h2 { margin: 0; font-size: 15px; }
    .tabs-sheet-list { overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .sheet-tab {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #101517;
      color: var(--muted);
    }
    .sheet-tab.active { border-color: var(--accent); color: var(--text); }
    .sheet-tab-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
    .login-modal {
      position: fixed;
      inset: 0;
      z-index: 40;
      background: rgba(8, 11, 13, 0.88);
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .login-modal[hidden] { display: none; }
    .login-card {
      width: min(100%, 380px);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .login-card h1 { margin: 0; font-size: 17px; }
    .login-card p { margin: 0; font-size: 13px; color: var(--muted); }
    .login-form { display: flex; gap: 8px; }
    .login-form input { flex: 1; min-width: 0; font-size: 16px; }
    .login-error { color: var(--danger); font-size: 12px; min-height: 16px; }
    .desktop-only { display: inline-flex; }
    @media (max-width: 767px) {
      .desktop-only { display: none !important; }
      .tabs { display: none; }
      .toolbar { padding: 6px 8px; }
      .toolbar input { font-size: 16px; }
      .mobile-bar { display: flex; }
    }
  </style>
</head>
<body>
  <header class="toolbar">
    <span class="brand desktop-only">pi-muse</span>
    <button id="back" class="desktop-only" type="button" title="Back">&#8592;</button>
    <button id="forward" class="desktop-only" type="button" title="Forward">&#8594;</button>
    <button id="reload" type="button" title="Reload">&#8635;</button>
    <input id="address" type="url" placeholder="https://example.com" spellcheck="false">
    <button id="go" type="button">Go</button>
    <button id="newTab" class="desktop-only" type="button">+ Tag</button>
    <button id="viewportToggle" class="desktop-only" type="button">桌面</button>
    <button id="desktopInputToggle" class="desktop-only" type="button">输入条</button>
    <button id="filesToggle" class="desktop-only" type="button">Files <span id="filesBadge" class="badge" hidden>0</span></button>
    <button id="reconnect" type="button">重连</button>
  </header>

  <nav id="tabs" class="tabs"></nav>

  <section id="handoffBanner" class="banner banner-handoff" hidden>
    <div id="handoffReason" class="banner-text"></div>
    <button id="handoffDone" class="banner-btn-ok" type="button">我已完成</button>
  </section>

  <section id="uploadPrompt" class="banner banner-upload" hidden>
    <div id="uploadPromptText" class="banner-text">网页请求选择本地文件上传</div>
    <button id="uploadPromptOpen" class="banner-btn-ok" type="button">选择文件</button>
  </section>

  <section id="filesPanel" class="files-panel" hidden>
    <div class="files-head">
      <h2>浏览器文件（上传 / 下载）</h2>
      <div><button id="filesRefresh" type="button">刷新</button> <button id="filesClose" type="button">关闭</button></div>
    </div>
    <div id="filesStatus" class="files-status" role="status"></div>
    <div id="uploads"></div>
    <div id="downloads"></div>
  </section>

  <main id="stage" class="stage">
    <div id="viewportWrap" class="viewport-wrap">
      <canvas id="canvas" width="1280" height="800"></canvas>
    </div>
    <textarea id="keyboard" spellcheck="false" autocomplete="off" aria-hidden="true"></textarea>
    <div id="tapRipple" class="tap-ripple"></div>
    <button id="zoomReset" class="zoom-reset" type="button" hidden>重置缩放</button>
    <div id="empty" class="empty">Connecting…</div>
    <div id="status" class="status">Disconnected</div>
  </main>

  <section id="nativeInputBar" class="native-input-bar" hidden>
    <input id="textInput" type="text" placeholder="输入中文 / 英文 / 粘贴内容…" autocomplete="off" enterkeyhint="send">
    <button id="textSend" class="banner-btn-ok" type="button">发送</button>
    <button id="keyEnter" type="button">Enter</button>
    <button id="keyBackspace" type="button">&#9003;</button>
    <button id="keyTab" type="button">Tab</button>
    <button id="keyEsc" type="button">Esc</button>
  </section>

  <nav id="mobileBar" class="mobile-bar">
    <button id="mBack" type="button" title="后退">&#8592;</button>
    <button id="mForward" type="button" title="前进">&#8594;</button>
    <button id="tabsToggle" type="button">标签 <span id="mTabsCount">0</span></button>
    <button id="keyboardToggle" type="button">键盘</button>
    <button id="gestureToggle" type="button">滚屏</button>
    <button id="mViewportToggle" type="button">手机</button>
    <button id="mFilesToggle" type="button">文件 <span id="mFilesBadge" class="badge" hidden>0</span></button>
  </nav>

  <div id="tabsSheet" class="tabs-sheet" hidden>
    <div class="tabs-sheet-card">
      <div class="tabs-sheet-head">
        <h2>标签页</h2>
        <div>
          <button id="sheetNewTab" type="button">+ 新建</button>
          <button id="tabsSheetClose" type="button">关闭</button>
        </div>
      </div>
      <div id="tabsSheetList" class="tabs-sheet-list"></div>
    </div>
  </div>

  <div id="loginModal" class="login-modal" hidden>
    <div class="login-card">
      <h1>Pi Muse 真实浏览器</h1>
      <p>输入服务端访问密钥（AccessKey）以连接实时浏览器。</p>
      <form id="login" class="login-form">
        <input id="accessKey" type="password" placeholder="Workspace access key" autocomplete="current-password">
        <button id="loginSubmit" type="submit">登录</button>
      </form>
      <div id="loginError" class="login-error" role="alert"></div>
    </div>
  </div>

<script>
(() => {
  const $ = (id) => document.getElementById(id);
  // 旧分享链接中的密钥绝不读取；尽早从地址栏和浏览器历史当前条目移除。
  const url = new URL(location.href);
  if (url.searchParams.has("accessKey") || url.searchParams.has("key")) {
    url.searchParams.delete("accessKey"); url.searchParams.delete("key");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }
  const state = {
    token: sessionStorage.getItem("pi-muse-browser-token") || "",
    authed: false,
    tabs: [],
    activeTabId: null,
    tabsVersion: 0,
    viewport: { preset: "desktop", width: 1280, height: 800, mobile: false },
    autoViewportChecked: false,
    handoff: null,
    frame: null,
    socket: null,
    connected: false,
    connectionId: 0,
    composing: false,
    pressedPointer: null,
    heldKeys: new Set(),
    lastMove: 0,
    lastPointer: null,
    frameId: 0,
    gestureMode: "scroll",
    zoom: { scale: 1, tx: 0, ty: 0 },
    filesOpen: false,
    files: { uploads: [], downloads: [] },
    fileReadId: 0,
    fileLoading: false,
    selections: new Map(),
    fileWrites: new Set(),
    uploadRows: new Map(),
    uploadHeading: null,
    uploadEmpty: null,
  };
  const activeTouches = new Map();
  let touchTrack = null;
  let pinchStart = null;
  let rippleTimer = null;

  const setStatus = (value) => { $("status").textContent = value; };
  const setLoginVisible = (visible, err = "") => {
    $("loginModal").hidden = !visible;
    $("loginError").textContent = err;
  };

  const applyZoom = (nextScale, nextTx, nextTy) => {
    const scale = Math.max(1, Math.min(4, nextScale));
    const tx = scale <= 1.01 ? 0 : nextTx;
    const ty = scale <= 1.01 ? 0 : nextTy;
    state.zoom = { scale: scale <= 1.01 ? 1 : scale, tx, ty };
    $("viewportWrap").style.transform = "translate(" + state.zoom.tx + "px, " + state.zoom.ty + "px) scale(" + state.zoom.scale + ")";
    $("zoomReset").hidden = state.zoom.scale <= 1.01;
  };
  const resetZoom = () => applyZoom(1, 0, 0);

  const mobileViewportSize = () => {
    const stageEl = $("stage");
    const rawW = (stageEl && stageEl.clientWidth) || window.innerWidth || 390;
    const rawH = (stageEl && stageEl.clientHeight) || window.innerHeight || 720;
    return {
      width: Math.max(360, Math.min(480, Math.round(rawW))),
      height: Math.max(520, Math.min(900, Math.round(rawH))),
    };
  };

  const updateViewportLabels = () => {
    const isMobilePreset = state.viewport?.preset === "mobile";
    $("viewportToggle").textContent = isMobilePreset ? "📱 手机" : "🖥️ 桌面";
    $("mViewportToggle").textContent = isMobilePreset ? "切桌面" : "切手机";
    $("viewportToggle").className = "desktop-only" + (isMobilePreset ? " active" : "");
    $("mViewportToggle").className = isMobilePreset ? "active" : "";
  };

  const updateFileBadges = () => {
    const pendingUploads = state.files?.uploads?.length || 0;
    const badge = $("filesBadge");
    const mBadge = $("mFilesBadge");
    badge.textContent = String(pendingUploads);
    mBadge.textContent = String(pendingUploads);
    badge.hidden = pendingUploads === 0;
    mBadge.hidden = pendingUploads === 0;
    $("uploadPrompt").hidden = !(state.connected && pendingUploads > 0 && !state.filesOpen);
  };

  const updateHandoffBanner = () => {
    const active = Boolean(state.handoff);
    $("handoffBanner").hidden = !active;
    $("handoffReason").textContent = state.handoff ? ("需要人工处理：" + state.handoff.reason) : "";
    $("handoffDone").disabled = !active;
  };

  const updateControls = () => {
    const ready = state.connected && state.socket?.readyState === WebSocket.OPEN;
    for (const id of [
      "back", "forward", "reload", "go", "newTab", "address", "keyboard",
      "viewportToggle", "desktopInputToggle", "filesToggle",
      "mBack", "mForward", "tabsToggle", "keyboardToggle", "gestureToggle", "mViewportToggle", "mFilesToggle",
      "textInput", "textSend", "keyEnter", "keyBackspace", "keyTab", "keyEsc", "sheetNewTab",
    ]) {
      const el = $(id);
      if (el) el.disabled = !ready;
    }
    $("reconnect").disabled = !state.authed && !state.token;
    $("tabs").style.pointerEvents = ready ? "auto" : "none";
    $("tabs").style.opacity = ready ? "1" : ".5";
    $("gestureToggle").textContent = state.gestureMode === "drag" ? "拖动中" : "滚屏";
    $("gestureToggle").className = state.gestureMode === "drag" ? "active" : "";
    $("mTabsCount").textContent = String(state.tabs.length);
    $("empty").textContent = !state.authed && !state.token
      ? "Login to start Chrome"
      : ready
        ? "No browser tab"
        : "Disconnected — tap 重连 to sync Chrome";
    $("empty").style.display = ready && state.tabs.length ? "none" : "grid";
    updateViewportLabels();
    updateFileBadges();
    updateHandoffBanner();
  };

  const clearFrame = () => {
    state.frame = null;
    state.frameId++;
    $("canvas").getContext("2d").clearRect(0, 0, $("canvas").width, $("canvas").height);
  };

  // 仅主动放弃当前连接或窗口失焦时释放输入；已断开的 socket 不宣称释放成功。
  const releaseHeldInput = () => {
    const socket = state.socket;
    if (state.connected && socket?.readyState === WebSocket.OPEN) {
      const pressed = state.pressedPointer;
      if (pressed) socket.send(JSON.stringify({ type: "pointer_up", ...pressed.point, button: pressed.button }));
      for (const key of [...state.heldKeys].reverse()) socket.send(JSON.stringify({ type: "key_up", key }));
    }
    state.pressedPointer = null; state.heldKeys.clear(); state.lastPointer = null;
    activeTouches.clear(); touchTrack = null; pinchStart = null;
  };

  const disconnect = (message, releaseInput = false) => {
    closeFiles();
    $("tabsSheet").hidden = true;
    if (releaseInput) releaseHeldInput();
    state.connectionId++;
    const socket = state.socket; state.socket = null; state.connected = false;
    if (socket) socket.close();
    state.pressedPointer = null; state.heldKeys.clear(); state.lastPointer = null; clearFrame();
    setStatus(message); updateControls();
  };

  const api = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers.Authorization = "Bearer " + state.token;
    if (options.body) headers["Content-Type"] = "application/json";
    const response = await fetch(path, { credentials: "same-origin", ...options, headers });
    if (response.status === 401) {
      state.token = "";
      state.authed = false;
      sessionStorage.removeItem("pi-muse-browser-token");
      disconnect("Login required");
      setLoginVisible(true);
      throw new Error("unauthorized");
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || ("HTTP " + response.status));
    return body;
  };

  const fileStatus = (message) => { $("filesStatus").textContent = message; };
  const safeName = (name) => name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\\.+/, "") || "upload.bin";
  const fileLabel = (tabId) => {
    const tab = state.tabs.find((item) => item.id === tabId);
    return tab ? (tab.title || tab.url || tab.id) + " (" + tab.id + ")" : tabId;
  };
  const textNode = (tag, value, className) => {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const action = (label, handler, disabled = false) => {
    const button = document.createElement("button"); button.type = "button";
    button.textContent = label; button.disabled = disabled; button.onclick = handler;
    return button;
  };
  const closeFiles = () => {
    state.filesOpen = false; state.fileReadId++; state.fileLoading = false;
    state.selections.clear(); state.uploadRows.clear(); state.uploadHeading = null; state.uploadEmpty = null;
    $("filesPanel").hidden = true;
    $("uploads").replaceChildren(); $("downloads").replaceChildren(); fileStatus("");
    updateFileBadges();
  };
  const readFileBase64 = async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 32768)
      binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
    return btoa(binary);
  };
  const afterFileWrite = async (error) => {
    const refreshed = await refreshFiles(true);
    if (error && state.filesOpen) fileStatus(error.message + (refreshed ? " — list checked" : "; " + $("filesStatus").textContent));
  };
  const uploadFiles = async (upload) => {
    const files = state.selections.get(upload.id) || [];
    if (!files.length) { fileStatus("Choose a local file first"); return; }
    if (files.length > (upload.multiple ? 4 : 1) || files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) {
      fileStatus("Choose at most " + (upload.multiple ? "4" : "1") + " files, 8 MiB total"); return;
    }
    const writeId = "upload:" + upload.id; if (state.fileWrites.has(writeId)) return;
    state.fileWrites.add(writeId); renderFiles();
    let error = null;
    try {
      const payload = await Promise.all(files.map(async (file) => ({ name: safeName(file.name), mimeType: file.type || "application/octet-stream", contentBase64: await readFileBase64(file) })));
      if (!state.filesOpen || !state.connected) return;
      await api("/api/browser/uploads/" + encodeURIComponent(upload.id), { method: "POST", body: JSON.stringify({ files: payload }) });
      state.selections.delete(upload.id);
    } catch (caught) { error = caught; }
    finally { state.fileWrites.delete(writeId); await afterFileWrite(error); }
  };
  const cancelUpload = async (upload) => {
    const writeId = "upload:" + upload.id; if (state.fileWrites.has(writeId)) return;
    state.fileWrites.add(writeId); renderFiles();
    let error = null;
    try { await api("/api/browser/uploads/" + encodeURIComponent(upload.id), { method: "DELETE" }); state.selections.delete(upload.id); }
    catch (caught) { error = caught; }
    finally { state.fileWrites.delete(writeId); await afterFileWrite(error); }
  };
  const saveDownload = async (download) => {
    if (download.status !== "completed" || !state.filesOpen) return;
    try {
      const content = await api("/api/browser/downloads/" + encodeURIComponent(download.id) + "/content");
      if (!state.filesOpen) return;
      const binary = atob(content.contentBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: content.mimeType || "application/octet-stream" }));
      try {
        const anchor = document.createElement("a"); anchor.href = objectUrl; anchor.download = safeName(content.name);
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
        fileStatus("Saved " + anchor.download);
      } finally { URL.revokeObjectURL(objectUrl); }
    } catch (error) { if (state.filesOpen) fileStatus(error.message || String(error)); }
  };
  const deleteDownload = async (download) => {
    if (!window.confirm("Delete browser download " + download.name + "?")) return;
    const writeId = "download:" + download.id; if (state.fileWrites.has(writeId)) return;
    state.fileWrites.add(writeId); renderFiles();
    let error = null;
    try { await api("/api/browser/downloads/" + encodeURIComponent(download.id), { method: "DELETE" }); }
    catch (caught) { error = caught; }
    finally { state.fileWrites.delete(writeId); await afterFileWrite(error); }
  };
  const renderFiles = () => {
    updateFileBadges();
    if (!state.filesOpen || !state.files) return;
    const { uploads, downloads } = state.files;
    for (const id of state.selections.keys()) if (!uploads.some((upload) => upload.id === id)) state.selections.delete(id);
    const uploadHost = $("uploads");
    if (!state.uploadHeading) { state.uploadHeading = textNode("h3", "待上传文件请求"); uploadHost.appendChild(state.uploadHeading); }
    // 实时推送只增量更新已有上传行；重挂 input 会中断仍打开的原生文件选择器。
    const presentIds = new Set(uploads.map((upload) => upload.id));
    for (const [id, entry] of state.uploadRows) {
      if (!presentIds.has(id)) { entry.row.remove(); state.uploadRows.delete(id); }
    }
    if (!uploads.length && !state.uploadEmpty) {
      state.uploadEmpty = textNode("p", "暂无待上传请求。请在网页中点击上传控件后再来选择本地文件。");
      uploadHost.appendChild(state.uploadEmpty);
    } else if (uploads.length && state.uploadEmpty) { state.uploadEmpty.remove(); state.uploadEmpty = null; }
    for (const upload of uploads) {
      let entry = state.uploadRows.get(upload.id);
      if (!entry) {
        const row = textNode("div", "", "file-row");
        const detail = textNode("div", "", "file-detail");
        const controls = textNode("div", "", "file-actions");
        const picker = document.createElement("input"); picker.type = "file"; picker.multiple = upload.multiple; picker.accept = upload.accept;
        const submit = action("Upload", () => uploadFiles(upload));
        const cancel = action("Cancel", () => cancelUpload(upload));
        picker.onchange = () => { state.selections.set(upload.id, Array.from(picker.files || [])); renderFiles(); };
        controls.append(picker, submit, cancel); row.append(detail, controls); uploadHost.appendChild(row);
        entry = { row, detail, picker, submit, cancel }; state.uploadRows.set(upload.id, entry);
      }
      const selected = state.selections.get(upload.id) || [];
      entry.detail.textContent = fileLabel(upload.tabId) + " · " + (upload.multiple ? "Multiple files" : "One file") + (upload.accept ? " · " + upload.accept : "") + (selected.length ? " · " + selected.map((file) => file.name + " (" + file.size + " bytes)").join(", ") : "");
      entry.picker.disabled = state.fileWrites.has("upload:" + upload.id);
      entry.submit.disabled = !selected.length || entry.picker.disabled;
      entry.cancel.disabled = entry.picker.disabled;
    }
    const downloadRows = [textNode("h3", "下载记录")];
    if (!downloads.length) downloadRows.push(textNode("p", "暂无下载"));
    for (const download of downloads) {
      const row = textNode("div", "", "file-row");
      row.appendChild(textNode("div", download.name + " · " + download.status + " · " + (download.bytes === null ? "size unknown" : download.bytes + " bytes") + (download.error ? " · " + download.error : ""), "file-detail"));
      const controls = textNode("div", "", "file-actions");
      if (download.status === "completed") controls.appendChild(action("Save", () => saveDownload(download)));
      controls.appendChild(action("Delete", () => deleteDownload(download), state.fileWrites.has("download:" + download.id)));
      row.appendChild(controls); downloadRows.push(row);
    }
    $("downloads").replaceChildren(...downloadRows);
  };
  const refreshFiles = async (force = false) => {
    if (!state.filesOpen || !state.connected || (state.fileLoading && !force)) return false;
    const readId = ++state.fileReadId; state.fileLoading = true;
    try {
      const files = await api("/api/browser/files");
      if (readId !== state.fileReadId || !state.filesOpen) return false;
      state.files = files; renderFiles(); fileStatus("Files updated"); return true;
    } catch (error) {
      if (readId === state.fileReadId && state.filesOpen) fileStatus("Unable to read files: " + (error.message || String(error)));
      return false;
    } finally { if (readId === state.fileReadId) state.fileLoading = false; }
  };
  const openFiles = () => {
    if (!state.connected) return;
    if (state.filesOpen) { closeFiles(); return; }
    state.filesOpen = true; $("filesPanel").hidden = false; renderFiles(); fileStatus("Loading files…");
    return refreshFiles(true);
  };
  $("filesToggle").onclick = openFiles;
  $("mFilesToggle").onclick = openFiles;
  $("uploadPromptOpen").onclick = () => { if (!state.filesOpen) openFiles(); };
  $("filesClose").onclick = closeFiles;
  $("filesRefresh").onclick = () => refreshFiles(true);

  const activeTab = () => state.tabs.find((tab) => tab.id === state.activeTabId);
  const renderTabs = () => {
    $("tabs").replaceChildren(...state.tabs.map((tab) => {
      const item = document.createElement("div");
      item.className = "tab" + (tab.id === state.activeTabId ? " active" : "");
      item.role = "button";
      item.tabIndex = 0;
      item.textContent = (tab.title || tab.url || tab.id).slice(0, 32);
      item.onclick = () => activate(tab.id);
      item.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(tab.id); } };
      const close = document.createElement("button");
      close.type = "button"; close.textContent = "x"; close.title = "Close"; close.className = "danger";
      close.onclick = (event) => { event.stopPropagation(); writeAndRefresh("/api/browser/tabs/" + tab.id, { method: "DELETE" }); };
      item.appendChild(close);
      return item;
    }));
    $("tabsSheetList").replaceChildren(...state.tabs.map((tab) => {
      const row = document.createElement("div");
      row.className = "sheet-tab" + (tab.id === state.activeTabId ? " active" : "");
      const titleBtn = document.createElement("button");
      titleBtn.type = "button";
      titleBtn.className = "sheet-tab-title";
      titleBtn.style.border = "0";
      titleBtn.style.background = "transparent";
      titleBtn.style.justifyContent = "flex-start";
      titleBtn.textContent = (tab.title || tab.url || tab.id).slice(0, 60);
      titleBtn.onclick = () => { $("tabsSheet").hidden = true; activate(tab.id); };
      const close = document.createElement("button");
      close.type = "button"; close.textContent = "关闭"; close.className = "danger";
      close.onclick = (event) => { event.stopPropagation(); writeAndRefresh("/api/browser/tabs/" + tab.id, { method: "DELETE" }); };
      row.append(titleBtn, close);
      return row;
    }));
    const tab = activeTab();
    if (tab && document.activeElement !== $("address")) $("address").value = tab.url === "about:blank" ? "" : tab.url;
    updateControls();
  };
  const showError = (error) => setStatus(error.message || String(error));
  const renderTabsFromResponse = (body) => {
    const previous = state.activeTabId;
    state.tabs = body.tabs;
    state.activeTabId = (state.tabs.find((tab) => tab.active) || {}).id || null;
    if (previous !== state.activeTabId) clearFrame();
    renderTabs();
  };
  const refresh = async () => {
    const version = state.tabsVersion;
    const body = await api("/api/browser/tabs");
    // WS ready/tabs 比并发中的旧 GET 更权威，不能用迟到快照覆盖它。
    if (version === state.tabsVersion) renderTabsFromResponse(body);
  };
  // 写请求即使网络失败也可能已执行：只读列表核对结果，绝不自动重发写请求。
  const writeAndRefresh = async (path, options) => {
    try { await api(path, options); } catch (error) { showError(error); }
    try { await refresh(); } catch (error) { showError(error); }
  };
  const activate = (tabId) => writeAndRefresh("/api/browser/tabs/" + tabId + "/activate", { method: "POST" });
  const navigation = async (actionName, targetUrl) => {
    const tab = activeTab(); if (!tab) return;
    await writeAndRefresh("/api/browser/tabs/" + tab.id + "/navigation", {
      method: "POST",
      body: JSON.stringify(actionName === "navigate" ? { action: actionName, url: targetUrl } : { action: actionName }),
    });
  };
  const toggleViewport = () => {
    const nextMobile = state.viewport?.preset !== "mobile";
    if (nextMobile) {
      const target = mobileViewportSize();
      send({ type: "viewport", preset: "mobile", width: target.width, height: target.height, mobile: true });
    } else {
      resetZoom();
      send({ type: "viewport", preset: "desktop", width: 1280, height: 800, mobile: false });
    }
  };
  const toggleInputBar = () => {
    const bar = $("nativeInputBar");
    bar.hidden = !bar.hidden;
    if (!bar.hidden) $("textInput").focus();
  };
  const connect = async () => {
    disconnect("Connecting…", true);
    const connectionId = state.connectionId;
    try {
      const { ticket } = await api("/api/browser/ws-ticket", { method: "POST", body: "{}" });
      if (connectionId !== state.connectionId) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(protocol + "//" + location.host + "/ws/browser?ticket=" + encodeURIComponent(ticket));
      socket.binaryType = "arraybuffer";
      state.socket = socket;
      const current = () => state.socket === socket && state.connectionId === connectionId;
      socket.onopen = () => { if (current()) setStatus("Synchronizing…"); };
      socket.onclose = () => { if (current()) disconnect("Disconnected — tap 重连"); };
      socket.onerror = () => { if (current()) disconnect("Connection failed — tap 重连"); };
      socket.onmessage = (event) => {
        if (!current()) return;
        if (typeof event.data === "string") {
          let message;
          try { message = JSON.parse(event.data); } catch { disconnect("Invalid browser message — tap 重连"); return; }
          if (message.type === "ready" || message.type === "tabs") {
            if (!Array.isArray(message.tabs)) return;
            const oldTab = state.activeTabId;
            state.tabs = message.tabs; state.activeTabId = message.activeTabId; state.tabsVersion++;
            if (oldTab !== state.activeTabId) clearFrame();
            if (message.type === "ready") {
              state.connected = true;
              if (message.viewport) state.viewport = message.viewport;
              if (message.files) state.files = message.files;
              state.handoff = message.handoff || null;
              setStatus("Connected");
              if (!state.autoViewportChecked) {
                state.autoViewportChecked = true;
                if (window.innerWidth < 768 && state.viewport?.preset === "desktop") {
                  const target = mobileViewportSize();
                  socket.send(JSON.stringify({ type: "viewport", preset: "mobile", width: target.width, height: target.height, mobile: true }));
                }
              }
            }
            renderTabs();
            if (message.type === "ready" && state.filesOpen) renderFiles();
          } else if (message.type === "viewport" && message.viewport) {
            state.viewport = message.viewport;
            if (!state.frame || state.frame.width !== message.viewport.width || state.frame.height !== message.viewport.height) {
              clearFrame();
              resetZoom();
            }
            updateControls();
          } else if (message.type === "files") {
            state.files = { uploads: message.uploads || [], downloads: message.downloads || [] };
            renderFiles();
            updateControls();
          } else if (message.type === "handoff") {
            state.handoff = message.handoff || null;
            updateHandoffBanner();
          } else if (message.type === "error") {
            setStatus(message.error);
          }
          return;
        }
        let metadata, bytes, metadataLength;
        try {
          bytes = new Uint8Array(event.data);
          if (bytes.byteLength < 5) throw new Error("short frame");
          metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
          if (metadataLength > bytes.byteLength - 4) throw new Error("invalid metadata length");
          metadata = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + metadataLength)));
        } catch { disconnect("Invalid frame — tap 重连"); return; }
        let acknowledged = false;
        const ackFrame = () => {
          if (acknowledged || !current() || socket.readyState !== WebSocket.OPEN) return;
          acknowledged = true;
          socket.send(JSON.stringify({ type: "frame_ack", frameId: metadata.frameId, sessionId: metadata.sessionId }));
        };
        // 当前 socket 的有效帧即使不绘制，也必须释放服务端 pendingFrame。
        if (!state.connected || metadata.tabId !== state.activeTabId) { ackFrame(); return; }
        const frameId = ++state.frameId;
        const image = new Image();
        const imageUrl = URL.createObjectURL(new Blob([bytes.subarray(4 + metadataLength)], { type: "image/jpeg" }));
        image.onload = () => {
          URL.revokeObjectURL(imageUrl);
          if (!current() || socket.readyState !== WebSocket.OPEN) return;
          try {
            if (state.connected && frameId === state.frameId && metadata.tabId === state.activeTabId) {
              const canvas = $("canvas"); canvas.width = image.width; canvas.height = image.height;
              canvas.getContext("2d").drawImage(image, 0, 0);
              state.frame = metadata;
              setStatus((state.viewport?.preset === "mobile" ? "Mobile " : "") + metadata.width + "x" + metadata.height + " · Frame " + metadata.frameId);
            }
          } finally { ackFrame(); }
        };
        image.onerror = () => { URL.revokeObjectURL(imageUrl); if (current()) { ackFrame(); setStatus("Frame decode failed"); } };
        image.src = imageUrl;
      };
    } catch (error) { if (connectionId === state.connectionId) disconnect(error.message || "Connection failed"); }
  };

  const stageLocalPoint = (event) => {
    const stageEl = $("stage");
    if (typeof event.clientX === "number" && typeof event.clientY === "number" && typeof stageEl.getBoundingClientRect === "function") {
      const rect = stageEl.getBoundingClientRect();
      return { sx: event.clientX - rect.left, sy: event.clientY - rect.top, width: rect.width, height: rect.height };
    }
    const canvas = $("canvas");
    return { sx: event.offsetX, sy: event.offsetY, width: canvas.clientWidth, height: canvas.clientHeight };
  };

  const point = (event) => {
    const canvas = $("canvas"); const frame = state.frame; if (!state.connected || !frame) return null;
    const local = stageLocalPoint(event);
    const cw = canvas.clientWidth || local.width || frame.width;
    const ch = canvas.clientHeight || local.height || frame.height;
    const cx = (local.sx - state.zoom.tx) / state.zoom.scale;
    const cy = (local.sy - state.zoom.ty) / state.zoom.scale;
    // canvas 使用 object-fit: contain；输入坐标必须扣除留白与本地缩放后按显示比例换算。
    const scale = Math.min(cw / frame.width, ch / frame.height);
    const x = (cx - (cw - frame.width * scale) / 2) / scale;
    const y = (cy - (ch - frame.height * scale) / 2) / scale;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
    return { x, y };
  };

  const showTapRipple = (event) => {
    const ripple = $("tapRipple");
    const local = stageLocalPoint(event);
    if (!Number.isFinite(local.sx) || !Number.isFinite(local.sy)) return;
    ripple.style.left = local.sx + "px";
    ripple.style.top = local.sy + "px";
    ripple.style.opacity = "1";
    ripple.style.transform = "scale(0.6)";
    if (rippleTimer) clearTimeout(rippleTimer);
    rippleTimer = setTimeout(() => {
      ripple.style.opacity = "0";
      ripple.style.transform = "scale(1.4)";
    }, 20);
  };

  const send = (message) => { if (state.connected && state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message)); };

  $("login").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessKey: $("accessKey").value }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || "Login failed");
      state.token = value.token;
      state.authed = true;
      sessionStorage.setItem("pi-muse-browser-token", value.token);
      $("accessKey").value = "";
      setLoginVisible(false);
      updateControls();
      await refresh(); await connect();
    } catch (error) { setLoginVisible(true, error.message || "Login failed"); }
  };

  $("newTab").onclick = () => writeAndRefresh("/api/browser/tabs", { method: "POST", body: "{}" });
  $("sheetNewTab").onclick = () => { $("tabsSheet").hidden = true; writeAndRefresh("/api/browser/tabs", { method: "POST", body: "{}" }); };
  $("reconnect").onclick = () => connect();
  $("viewportToggle").onclick = toggleViewport;
  $("mViewportToggle").onclick = toggleViewport;
  $("desktopInputToggle").onclick = toggleInputBar;
  $("keyboardToggle").onclick = toggleInputBar;
  $("gestureToggle").onclick = () => {
    state.gestureMode = state.gestureMode === "scroll" ? "drag" : "scroll";
    updateControls();
  };
  $("tabsToggle").onclick = () => { $("tabsSheet").hidden = !$("tabsSheet").hidden; };
  $("tabsSheetClose").onclick = () => { $("tabsSheet").hidden = true; };
  $("tabsSheet").onclick = (event) => { if (event.target === $("tabsSheet")) $("tabsSheet").hidden = true; };
  $("zoomReset").onclick = resetZoom;
  $("handoffDone").onclick = async () => {
    $("handoffDone").disabled = true;
    try {
      await api("/api/browser/handoff", { method: "DELETE" });
      state.handoff = null;
      updateHandoffBanner();
    } catch (error) {
      $("handoffDone").disabled = false;
      showError(error);
    }
  };
  $("address").onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = $("address").value.trim();
      if (value) navigation("navigate", /^(https?:\\/\\/)/i.test(value) ? value : "https://" + value);
    }
  };
  $("go").onclick = () => $("address").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  $("back").onclick = () => navigation("back");
  $("mBack").onclick = () => navigation("back");
  $("forward").onclick = () => navigation("forward");
  $("mForward").onclick = () => navigation("forward");
  $("reload").onclick = () => navigation("reload");

  const insertText = (value) => { for (let offset = 0; offset < value.length; offset += 2000) send({ type: "insert_text", text: value.slice(offset, offset + 2000) }); };
  const pressSingleKey = (k) => { send({ type: "key_down", key: k }); send({ type: "key_up", key: k }); };
  const sendNativeText = () => {
    const val = $("textInput").value;
    if (!val) return;
    insertText(val);
    $("textInput").value = "";
  };
  $("textSend").onclick = sendNativeText;
  $("textInput").onkeydown = (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      if ($("textInput").value) sendNativeText();
      else pressSingleKey("Enter");
    }
  };
  $("keyEnter").onclick = () => pressSingleKey("Enter");
  $("keyBackspace").onclick = () => pressSingleKey("Backspace");
  $("keyTab").onclick = () => pressSingleKey("Tab");
  $("keyEsc").onclick = () => pressSingleKey("Escape");

  const stage = $("keyboard");
  const button = (number) => ({ 0: "left", 1: "middle", 2: "right" })[number];
  const releasePointer = (event) => {
    const pressed = state.pressedPointer; if (!pressed || pressed.pointerId !== event.pointerId) return;
    const p = point(event) || state.lastPointer || pressed.point;
    send({ type: "pointer_up", ...p, button: pressed.button });
    state.pressedPointer = null; state.lastPointer = null;
  };

  const distanceBetween = (a, b) => Math.hypot(a.sx - b.sx, a.sy - b.sy);

  stage.onpointermove = (event) => {
    if (event.pointerType === "touch") {
      if (activeTouches.has(event.pointerId)) activeTouches.set(event.pointerId, stageLocalPoint(event));
      if (activeTouches.size === 2 && pinchStart) {
        const pts = [...activeTouches.values()];
        const dist = Math.max(10, distanceBetween(pts[0], pts[1]));
        const midX = (pts[0].sx + pts[1].sx) / 2;
        const midY = (pts[0].sy + pts[1].sy) / 2;
        const nextScale = Math.max(1, Math.min(4, pinchStart.scale * (dist / pinchStart.dist)));
        const ratio = nextScale / pinchStart.scale;
        const nextTx = midX - (pinchStart.midX - pinchStart.tx) * ratio;
        const nextTy = midY - (pinchStart.midY - pinchStart.ty) * ratio;
        applyZoom(nextScale, nextTx, nextTy);
        return;
      }
      if (touchTrack && touchTrack.pointerId === event.pointerId) {
        const local = stageLocalPoint(event);
        const dx = local.sx - touchTrack.lastX;
        const dy = local.sy - touchTrack.lastY;
        touchTrack.lastX = local.sx;
        touchTrack.lastY = local.sy;
        if (Math.hypot(local.sx - touchTrack.startX, local.sy - touchTrack.startY) > 8) touchTrack.moved = true;
        if (touchTrack.moved && (Math.abs(dx) > 0 || Math.abs(dy) > 0)) {
          const p = point(event);
          if (p) state.lastPointer = p;
          send({
            type: "wheel",
            ...(p || {}),
            deltaX: Math.max(-100000, Math.min(100000, -dx * 1.4)),
            deltaY: Math.max(-100000, Math.min(100000, -dy * 1.4)),
          });
        }
        return;
      }
      if (!state.pressedPointer || state.pressedPointer.pointerId !== event.pointerId) return;
    }
    const now = performance.now(); if (now - state.lastMove < 30) return; state.lastMove = now;
    const p = point(event); if (p) { state.lastPointer = p; send({ type: "pointer_move", ...p }); }
  };

  stage.onpointerdown = (event) => {
    if (event.pointerType === "touch") {
      event.preventDefault();
      const local = stageLocalPoint(event);
      activeTouches.set(event.pointerId, local);
      try { stage.setPointerCapture(event.pointerId); } catch {}
      if (activeTouches.size === 2) {
        touchTrack = null;
        if (state.pressedPointer) {
          send({ type: "pointer_up", ...(state.lastPointer || state.pressedPointer.point), button: state.pressedPointer.button });
          state.pressedPointer = null;
        }
        const pts = [...activeTouches.values()];
        pinchStart = {
          dist: Math.max(10, distanceBetween(pts[0], pts[1])),
          midX: (pts[0].sx + pts[1].sx) / 2,
          midY: (pts[0].sy + pts[1].sy) / 2,
          scale: state.zoom.scale,
          tx: state.zoom.tx,
          ty: state.zoom.ty,
        };
        return;
      }
      if (activeTouches.size === 1) {
        if (state.gestureMode === "drag") {
          const p = point(event); if (!p || state.pressedPointer) return;
          state.lastPointer = p;
          state.pressedPointer = { pointerId: event.pointerId, button: "left", point: p };
          send({ type: "pointer_down", ...p, button: "left" });
        } else {
          touchTrack = {
            pointerId: event.pointerId,
            startX: local.sx,
            startY: local.sy,
            lastX: local.sx,
            lastY: local.sy,
            startTime: performance.now(),
            moved: false,
          };
        }
      }
      return;
    }
    const p = point(event), mapped = button(event.button);
    if (!p || !mapped || state.pressedPointer) return;
    if (mapped !== "left") event.preventDefault();
    stage.setPointerCapture(event.pointerId); state.lastPointer = p;
    state.pressedPointer = { pointerId: event.pointerId, button: mapped, point: p };
    send({ type: "pointer_down", ...p, button: mapped });
  };

  const endTouchOrPointer = (event) => {
    if (event.pointerType === "touch") {
      activeTouches.delete(event.pointerId);
      if (activeTouches.size < 2) pinchStart = null;
      if (touchTrack && touchTrack.pointerId === event.pointerId) {
        const track = touchTrack;
        touchTrack = null;
        if (!track.moved && performance.now() - track.startTime < 350) {
          const p = point(event);
          if (p) {
            showTapRipple(event);
            send({ type: "click", ...p, button: "left", clickCount: 1 });
          }
        }
        return;
      }
    }
    releasePointer(event);
  };

  stage.onpointerup = endTouchOrPointer;
  stage.onpointercancel = endTouchOrPointer;
  stage.onlostpointercapture = endTouchOrPointer;
  stage.oncontextmenu = (event) => event.preventDefault();
  stage.onauxclick = (event) => event.preventDefault();
  stage.onwheel = (event) => {
    if (!state.connected) return;
    event.preventDefault();
    const p = point(event);
    if (p) state.lastPointer = p;
    send({ type: "wheel", ...(p || {}), deltaX: Math.max(-100000, Math.min(100000, event.deltaX)), deltaY: Math.max(-100000, Math.min(100000, event.deltaY)) });
  };

  // 普通字符（含粘贴）只从 input 取实际文本；组合键与特殊键按 Playwright 键名逐键发送。
  const keyName = (event) => {
    const names = { " ": "Space", Escape: "Escape", Esc: "Escape", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", Control: "Control", Shift: "Shift", Alt: "Alt", Meta: "Meta" };
    if (names[event.key]) return names[event.key];
    if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) return event.key;
    if (/^[a-zA-Z0-9]$/.test(event.key)) return event.key.toLowerCase();
    const codes = { Backquote: "Backquote", Minus: "Minus", Equal: "Equal", BracketLeft: "BracketLeft", BracketRight: "BracketRight", Backslash: "Backslash", Semicolon: "Semicolon", Quote: "Quote", Comma: "Comma", Period: "Period", Slash: "Slash" };
    return codes[event.code] || null;
  };
  let suppressInput = "";
  stage.oncompositionstart = () => { state.composing = true; };
  stage.oncompositionend = (event) => { state.composing = false; stage.value = ""; suppressInput = event.data || ""; insertText(event.data || ""); };
  stage.oninput = (event) => {
    if (state.composing) return;
    const value = stage.value || event.data || ""; stage.value = "";
    if (suppressInput && (value === suppressInput || event.data === suppressInput)) { suppressInput = ""; return; }
    suppressInput = "";
    insertText(value);
  };
  stage.onkeydown = (event) => {
    if (!state.connected || state.composing || event.isComposing || event.key === "Process" || event.key === "Dead") return;
    const modified = event.ctrlKey || event.metaKey || event.altKey;
    const special = modified || event.key.length !== 1;
    if (!special) return;
    // 粘贴由本地 textarea 的 input 事件取得真实文字，避免远端再执行一次快捷键。
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    const key = keyName(event); if (!key) return;
    event.preventDefault();
    if (!state.heldKeys.has(key)) { state.heldKeys.add(key); send({ type: "key_down", key }); }
  };
  stage.onkeyup = (event) => { const key = keyName(event); if (key && state.heldKeys.delete(key)) { event.preventDefault(); send({ type: "key_up", key }); } };
  window.addEventListener("blur", releaseHeldInput);

  (async () => {
    updateControls();
    try {
      const headers = state.token ? { Authorization: "Bearer " + state.token } : {};
      let res = await fetch("/api/browser/status", { credentials: "same-origin", headers });
      if (res.status === 401) {
        state.token = "";
        sessionStorage.removeItem("pi-muse-browser-token");
        const silent = await fetch("/api/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessKey: "" }),
        });
        if (silent.ok) {
          const data = await silent.json();
          state.token = data.token;
          sessionStorage.setItem("pi-muse-browser-token", data.token);
          res = await fetch("/api/browser/status", {
            credentials: "same-origin",
            headers: { Authorization: "Bearer " + state.token },
          });
        }
      }
      if (!res.ok) {
        setLoginVisible(true);
        setStatus("Login required");
        updateControls();
        return;
      }
      const statusData = await res.json();
      state.authed = true;
      if (statusData.viewport) state.viewport = statusData.viewport;
      state.handoff = statusData.handoff || null;
      setLoginVisible(false);
      updateControls();
      if (!statusData.enabled) {
        setStatus("Browser disabled on server");
        return;
      }
      await refresh();
      await connect();
    } catch {
      setLoginVisible(true);
      updateControls();
    }
  })();
})();
</script>
</body>
</html>`;
