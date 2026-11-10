import { Hono } from "hono";
import type { CompanionService } from "../../features/companions/service.js";
import { CompanionError } from "../../features/companions/types.js";
import { companionAssetRequest, companionMetadataRequest } from "../contracts/companions.js";

/** 只做协议转换；鉴权由父 app 的 /api/* 中间件承担。 */
export const createCompanionRoutes = (companions: CompanionService) => {
  const app = new Hono();
  app.get("/", async (c) => c.json(await companions.list()));
  app.get("/:packId", async (c) => c.json(await companions.get(c.req.param("packId"))));
  app.get("/:packId/assets/:state", async (c) => {
    const { bytes, etag } = await companions.asset(c.req.param("packId"), c.req.param("state"));
    return c.body(new Uint8Array(bytes), 200, { "Content-Type": "image/png", ETag: `"${etag}"`, "Cache-Control": "private, max-age=300" });
  });
  app.put("/:packId", async (c) => {
    const input = companionMetadataRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) throw new CompanionError("INVALID_COMPANION_METADATA", "Invalid companion metadata", 400);
    return c.json(await companions.saveMetadata(c.req.param("packId"), input.data));
  });
  app.put("/:packId/assets/:state", async (c) => {
    const input = companionAssetRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) throw new CompanionError("INVALID_PNG", "Expected a base64 PNG JSON body", 400);
    return c.json(await companions.saveAsset(c.req.param("packId"), c.req.param("state"), input.data.dataBase64));
  });
  app.delete("/:packId", async (c) => c.json(await companions.remove(c.req.param("packId"))));
  return app;
};
