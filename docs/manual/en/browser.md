# Real Browser Guide {#browser}

Pi Muse runs a **full, headed Google Chrome** (`headless: false`, never a headless substitute) shared across mobile clients, desktop browsers, and agent tools with persistent login state stored under `DATA_DIR/runtime/browser/profile/`.

## Deployment Modes {#deployment-modes}

Pick any of the following runtime modes (the HTTP/WebSocket API and behavior remain identical):

1. **macOS / Linux Desktop (Default)**: Lazily launches the local system Chrome on demand (optionally specifying `tools.browser.executablePath`).
2. **Docker on Headless Linux Servers**: Build and run the slim single container via `Dockerfile` and `compose.browser.yaml` (`Xvfb + google-chrome-stable + Node` only — no X11 forwarding, VNC, or noVNC required). Exposes only port `12330`.
3. **External Chrome via CDP**: Set `tools.browser.cdpUrl` in `config.json` to a credential-free `http(s)://` or `ws(s)://` CDP endpoint (e.g. `http://127.0.0.1:9222`) to attach to an existing Chrome instance.

## Responsive Viewer Page `/browser` {#viewer}

The server includes a built-in responsive viewer at `/browser` (and embeds it in the `web/` workbench's "Browser" tab):

- **Authentication**:
  - Clients holding a Bearer token can call `POST /api/browser/viewer-ticket` for a 60-second single-use `launchPath` and open `/browser/launch?ticket=...` on the same origin. The server sets a scoped `HttpOnly; SameSite=Strict` session cookie (valid only for `/api/browser/*`, excluding `viewer-ticket`) and redirects (`303`) to `/browser`.
  - Visiting `/browser` directly performs a silent empty-key session boot when `server.accessKey` is unset, or prompts for the AccessKey via `POST /api/session` (immediately stripping any `?accessKey` or `?key` query parameter from the URL).
- **HTTP & HTTPS Agnostic**: Uses relative REST URLs and same-origin `ws://` / `wss://` matching the current page origin (HTTPS reverse proxies only need to forward WebSocket upgrades on `/ws/browser`).
- **Mobile Touch & Native Input**:
  - Opening `/browser` on a narrow mobile screen automatically switches the shared viewport to `mobile`; toolbar toggles let desktop and phone users switch freely between mobile and `1280×800` desktop presets (updating both Chrome's viewport and `Emulation.setTouchEmulationEnabled`).
  - Single-finger tap dispatches a click with visual ripple feedback; default scroll mode translates vertical/horizontal swipes into page wheel events, while toggling drag mode enables pointer dragging; two-finger pinch zooms `1x–4x` locally for small UI targets.
  - Tapping the keyboard button opens a native text input bar supporting system Chinese/English IME composition and sending text over WebSocket `insert_text`—even over plain HTTP LAN connections.
- **Tabs, Files, and Human Handoff**:
  - Mobile uses a bottom-sheet tab drawer; desktop displays a tab bar. WebSocket `files` pushes keep upload choosers (`input[type=file]`) and downloads (`DATA_DIR/runtime/browser/downloads/`) synchronized in real time.
  - When encountering login, QR codes, 2FA, or CAPTCHAs, the assistant calls `request_handoff`, notifying clients via `/api/events` (`browser_updated`) and `/ws/browser`. After completing the step in `/browser`, tap "我已完成" (`DELETE /api/browser/handoff`) so the assistant can proceed.

## Agent Tools & Security Boundaries {#agent-and-security}

- **Unified `browser` Tool**: Supports `status`, `tabs` (`list`/`new`/`close`/`activate`), `navigate`, `back`/`forward`/`reload`, `snapshot` (ARIA tree + element `ref`s), `screenshot` (JPEG image block for visual reasoning), `act` (1–20 steps including `click`/`type`/`press`/`scroll`/`hover`/`select`), `wait`, and `request_handoff`.
- **Built-in `browser` Subagent**: Declared in `assets/subagents/browser.md` for single-mode delegation; `parallel` subagent mode automatically strips `browser` to prevent shared-tab collisions.
- **Safety Boundaries**: Never exposes arbitrary JS `evaluate`, cookies, localStorage, or passwords to the model; blocks loopback and private-network targets unless `tools.browser.allowPrivateTargets: true` is configured; treats external page text and screenshots as untrusted data.

Related pages:

- [Configuration](configuration.md#real-browser)
- [Profile and settings](profile-and-settings.md#real-browser)
- [Troubleshooting](troubleshooting.md#browser-cannot-open)
