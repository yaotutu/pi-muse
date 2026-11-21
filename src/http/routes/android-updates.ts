import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { AndroidReleaseMirror } from "../../adapters/releases/android-release-mirror.js";

export const createAndroidUpdateRoutes = (mirror: AndroidReleaseMirror) => {
  const app = new Hono();
  app.post("/refresh", (c) => {
    // 无凭据的提示只唤醒固定来源同步，忽略任何请求参数。
    mirror.notify();
    return c.json({ accepted: true }, 202, { "cache-control": "no-store" });
  });
  app.get("/latest", async (c) => {
    mirror.checkIfDue();
    const release = await mirror.latest();
    return release
      ? c.json(release, 200, { "cache-control": "no-store" })
      : c.json({ error: "No mirrored Android release available" }, 503, { "cache-control": "no-store" });
  });
  app.get("/apk/:tag/:name", async (c) => {
    const name = c.req.param("name");
    const asset = await mirror.asset(c.req.param("tag"), name);
    if (!asset) return c.json({ error: "APK not found" }, 404);
    const headers = {
      "content-type": "application/vnd.android.package-archive",
      "content-disposition": `attachment; filename="${name}"`,
      "content-length": String(asset.size),
      "cache-control": "public, max-age=86400, immutable",
      etag: `"${asset.digest}"`,
    };
    if (c.req.header("if-none-match") === headers.etag) return new Response(null, { status: 304, headers });
    if (c.req.method === "HEAD") return new Response(null, { headers });
    return new Response(Readable.toWeb(createReadStream(asset.path)) as unknown as ReadableStream, { headers });
  });
  return app;
};
