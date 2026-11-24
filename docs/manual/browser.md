# 真实浏览器指南 {#browser}

Pi Muse 提供**完整、带 GUI 的真实 Google Chrome**（固定 `headless: false`，不使用 headless 替代），并与手机端、桌面端和助手工具共享同一个浏览器实例、标签页与持久登录态（`DATA_DIR/runtime/browser/profile/`）。

## 运行形态与部署方式 {#deployment-modes}

按运行环境选择以下三种方式之一（对外协议完全一致）：

1. **macOS / Linux 桌面直连（默认）**：首次调用时懒启动本机系统 Chrome（支持 `tools.browser.executablePath` 指定路径）。
2. **Docker 无桌面 Linux 服务器**：使用项目根目录 `Dockerfile` 与 `compose.browser.yaml` 运行精简单容器（仅 `Xvfb + google-chrome-stable + Node`），无需安装 X11 转发或 VNC/noVNC，仅对外暴露 API 端口 `12330`。
3. **外部 Chrome CDP 附着**：在 `config.json` 设置 `tools.browser.cdpUrl`（无凭据的 `http(s)://` 或 `ws(s)://` 地址，如 `http://127.0.0.1:9222`），由服务端附着到已运行的真实 Chrome。

## 手机与桌面操控页 `/browser` {#viewer}

服务端直接内建响应式真实浏览器操控页 `/browser`（同时在 `web/` 联调台提供「浏览器」视图标签）：

- **认证与免密直开**：
  - 客户端可通过已登录的 Bearer Token 调用 `POST /api/browser/viewer-ticket` 换取 60 秒一次性 `launchPath`，用同源 `/browser/launch?ticket=...` 打开；服务端签发 `HttpOnly; SameSite=Strict` 会话 cookie（仅限 `/api/browser/*` 且不包含 `viewer-ticket`）并 `303` 跳转到 `/browser`。
  - 直接访问 `/browser` 时，若服务端未设置 `server.accessKey`，页面自动静默完成一次无密钥会话认证并连上 `/ws/browser`；若已配置 `server.accessKey`，则弹出访问密钥输入框登录（并在初始化时立即清除 URL 中的 `?accessKey`/`?key` 查询参数）。
- **协议与网络兼容**：自动使用当前访问协议的同源 `http(s)://` 与 `ws(s)://`，HTTP 局域网与 HTTPS 反向代理均可直接使用（反代需透传 `/ws/browser` Upgrade 头）。
- **移动端触控与中文输入**：
  - 窄屏打开时自动切换共享视口到手机尺寸（`preset: "mobile"`），顶部/底部按钮可随时在**手机视口**与**桌面 `1280×800`** 之间实时切换（同步调整 Chrome 视口与 `Emulation.setTouchEmulationEnabled`）。
  - 单指短按触发页面点击并显示波纹反馈；默认「滚屏」模式下滑动发送页面滚轮，切换为「拖动中」模式可拖拽/框选；双指捏合支持 `1x–4x` 画面缩放查看小号文字。
  - 底部「键盘」呼出原生输入条，直接调用系统中文/英文输入法并通过 WS `insert_text` 发送到 Chrome 当前焦点，明文 HTTP 局域网也可正常使用输入法。
- **标签、文件与人工接管（Handoff）**：
  - 移动端底部「标签」弹出半屏标签管理抽屉（新建/切换/关闭）；顶部/底部「文件」徽标由 WS `files` 事件实时更新，网页弹出上传选择器或触发下载时会弹出横幅提示（`DATA_DIR/runtime/browser/downloads/`）。
  - 遇到登录、扫码、短信或图形验证码时，助手调用 `request_handoff` 暂停并通过工作区 `/api/events`（`browser_updated`）与 `/ws/browser` 实时通知各端；用户在 `/browser` 完成人工操作后点击「我已完成」（`DELETE /api/browser/handoff`）即可通知助手继续。

## 助手能力与安全边界 {#agent-and-security}

- **统一 `browser` 工具**：支持 `status`、`tabs`（`list`/`new`/`close`/`activate`）、`navigate`、`back`/`forward`/`reload`、`snapshot`（无障碍树 + `ref`）、`screenshot`（JPEG 画面视觉回看）、`act`（1–20 步 `click`/`type`/`press`/`scroll`/`hover`/`select`）、`wait` 与 `request_handoff`。
- **专用 `browser` 子代理角色**：内置角色 `assets/subagents/browser.md` 在 `subagent` 单任务模式下可用；`parallel` 并行子代理会自动剥离 `browser` 工具，避免多个子代理在共享标签页互相覆盖。
- **不可信与隐私边界**：不向模型提供任意 JavaScript `evaluate`，也不暴露 cookie、localStorage 或密码原文；默认拦截回环与私网目标（本地测试可显式设 `tools.browser.allowPrivateTargets: true`）；网页文本与截图均视为不可信外部数据。

相关参考：

- [配置说明](configuration.md#real-browser)
- [资料与设置](profile-and-settings.md#real-browser)
- [常见问题](troubleshooting.md#browser-cannot-open)
