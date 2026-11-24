import { Hono } from "hono";
import type { BrowserService } from "../../features/browser/browser-service.js";
import { BrowserError } from "../../features/browser/types.js";
import {
  browserLaunchQuerySchema,
  browserNavigationSchema,
  browserUploadRequest,
  browserViewportUpdateSchema,
  createBrowserTabSchema,
} from "../contracts/browser.js";
import { browserViewerPage } from "../browser-viewer-page.js";

const securityHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
} as const;

const DEFAULT_VIEWPORT = {
  preset: "desktop" as const,
  width: 1280,
  height: 800,
  mobile: false,
};

/** 浏览器 REST 只做契约校验与受控错误投影；WS 升级由 Node server 适配层处理。 */
export const createBrowserRoutes = (
  browser: BrowserService | undefined,
) => {
  const app = new Hono();

  const error = (caught: unknown): {
    body: { error: string; code: string };
    status: 400 | 404 | 409 | 413 | 500;
  } => {
    if (!(caught instanceof BrowserError))
      return { body: { error: "Browser operation failed", code: "BROWSER_FAILED" }, status: 500 };
    const status =
      caught.code === "TAB_NOT_FOUND" ||
      caught.code === "UPLOAD_NOT_FOUND" ||
      caught.code === "DOWNLOAD_NOT_FOUND" ||
      caught.code === "HANDOFF_NOT_FOUND"
        ? 404
        : caught.code === "DOWNLOAD_NOT_READY"
          ? 409
          : caught.code === "PAYLOAD_TOO_LARGE"
            ? 413
            : caught.code === "INVALID_INPUT"
              ? 400
              : 500;
    return {
      body: { error: caught.message, code: caught.code },
      status,
    };
  };

  app.get("/browser", (c) =>
    c.html(browserViewerPage, 200, { "cache-control": "no-store" }),
  );

  // 一次性免登入口：消费 ticket 后签发仅限于 /api/browser/*（不含 viewer-ticket）的 HttpOnly cookie。
  app.get("/browser/launch", (c) => {
    if (!browser) {
      return c.json({ error: "Browser is disabled", code: "BROWSER_DISABLED" }, 503, securityHeaders);
    }
    const parsed = browserLaunchQuerySchema.safeParse({ ticket: c.req.query("ticket") });
    if (!parsed.success) {
      return c.json({ error: "Invalid or expired browser ticket", code: "INVALID_TICKET" }, 401, securityHeaders);
    }
    const session = browser.consumeViewerTicket(parsed.data.ticket);
    if (!session) {
      return c.json({ error: "Invalid or expired browser ticket", code: "INVALID_TICKET" }, 401, securityHeaders);
    }
    const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
    const cookie =
      `pi_muse_browser=${session.sessionId}; HttpOnly; SameSite=Strict; ` +
      `Path=/; Max-Age=${session.maxAgeSeconds}${secure}`;
    return new Response(null, {
      status: 303,
      headers: {
        ...securityHeaders,
        "set-cookie": cookie,
        location: "/browser",
      },
    });
  });

  app.get("/api/browser/status", async (c) => {
    if (!browser) {
      return c.json({
        enabled: false,
        running: false,
        viewerPath: null,
        tabsCount: 0,
        activeTabId: null,
        viewport: DEFAULT_VIEWPORT,
        pendingUploadsCount: 0,
        downloadsCount: 0,
        handoff: null,
      }, 200, securityHeaders);
    }
    try {
      return c.json(await browser.status(), 200, securityHeaders);
    } catch (caught) {
      const value = error(caught);
      return c.json(value.body, value.status, securityHeaders);
    }
  });

  app.post("/api/browser/viewer-ticket", (c) => {
    if (!browser) {
      return c.json({ error: "Browser is disabled", code: "BROWSER_DISABLED" }, 503, securityHeaders);
    }
    return c.json(browser.createViewerTicket(), 200, securityHeaders);
  });

  if (!browser) return app;

  app.put("/api/browser/viewport", async (c) => {
    const parsed = browserViewportUpdateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid browser viewport request", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json({ viewport: await browser.setViewport(parsed.data) });
    } catch (caught) {
      const value = error(caught);
      return c.json(value.body, value.status);
    }
  });

  app.delete("/api/browser/handoff", (c) => {
    try {
      return c.json(browser.resolveHandoff());
    } catch (caught) {
      const value = error(caught);
      return c.json(value.body, value.status);
    }
  });

  app.get("/api/browser/tabs", async (c) => {
    try { return c.json({ tabs: await browser.listTabs() }); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.post("/api/browser/tabs", async (c) => {
    const parsed = createBrowserTabSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid browser tab request", code: "INVALID_REQUEST" }, 400);
    try { return c.json(await browser.newTab(parsed.data.url)); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.delete("/api/browser/tabs/:tabId", async (c) => {
    try { return c.json({ tabs: await browser.closeTab(c.req.param("tabId")) }); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.post("/api/browser/tabs/:tabId/activate", async (c) => {
    try { return c.json(await browser.activateTab(c.req.param("tabId"))); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.post("/api/browser/tabs/:tabId/navigation", async (c) => {
    const parsed = browserNavigationSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid browser navigation request", code: "INVALID_REQUEST" }, 400);
    const tabId = c.req.param("tabId");
    try {
      const tab = parsed.data.action === "navigate"
        ? await browser.navigate(tabId, parsed.data.url)
        : parsed.data.action === "back"
          ? await browser.history(tabId, "back")
          : parsed.data.action === "forward"
            ? await browser.history(tabId, "forward")
            : await browser.reload(tabId);
      return c.json(tab);
    } catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.post("/api/browser/ws-ticket", (c) => c.json(browser.createTicket()));

  app.get("/api/browser/files", async (c) => {
    try { return c.json(await browser.listFiles()); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.post("/api/browser/uploads/:uploadId", async (c) => {
    const parsed = browserUploadRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return c.json({ error: "Invalid browser upload request", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await browser.uploadFiles(c.req.param("uploadId"), parsed.data.files));
    } catch (caught) {
      const value = error(caught);
      return c.json(value.body, value.status);
    }
  });

  app.delete("/api/browser/uploads/:uploadId", async (c) => {
    try { return c.json(await browser.cancelUpload(c.req.param("uploadId"))); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.get("/api/browser/downloads/:downloadId/content", async (c) => {
    try { return c.json(await browser.downloadContent(c.req.param("downloadId"))); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  app.delete("/api/browser/downloads/:downloadId", async (c) => {
    try { return c.json(await browser.deleteDownload(c.req.param("downloadId"))); }
    catch (caught) { const value = error(caught); return c.json(value.body, value.status); }
  });

  return app;
};
