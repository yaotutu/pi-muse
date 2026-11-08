import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { updateDreamSchema, resolveDreamPendingSchema } from "../contracts/rest.js";

/** 全局 Dream 整理状态概览与全局提示词设置。 */
export const createDreamRoutes = (
  dependencies: Pick<HttpDependencies, "dream">,
) => {
  const { dream } = dependencies;
  const app = new Hono();
  app.get("/api/dream", async (c) => c.json(await dream.describeAll()));
  app.put("/api/dream", async (c) => {
    const parsed = updateDreamSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid dream request", code: "INVALID_REQUEST" }, 400);
    return c.json(await dream.updateSettings(parsed.data));
  });
  app.post("/api/dream/run", async (c) => {
    const result = await dream.runNow();
    return result.ok ? c.json(result.state) : c.json({ error: result.message, code: result.code }, result.code === "not_found" ? 404 : 409);
  });
  app.post("/api/dream/pending/:pendingId", async (c) => {
    const parsed = resolveDreamPendingSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid Dream decision", code: "INVALID_REQUEST" }, 400);
    const result = await dream.resolvePending(c.req.param("pendingId"), parsed.data);
    return result.ok ? c.json(result.state) : c.json({ error: result.message, code: result.code }, result.code === "not_found" ? 404 : 409);
  });
  return app;
};
