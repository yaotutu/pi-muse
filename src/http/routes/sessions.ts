import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { isSessionId } from "../../adapters/storage/data-layout.js";
import { createSessionSchema, deleteSessionSchema, renameSessionSchema, resetSessionSchema } from "../contracts/rest.js";

/** 会话生命周期入口；不接纳客户端提供的公开 id，不隐式创建会话。 */
export const createSessionRoutes = (deps: HttpDependencies) => {
  const app = new Hono();
  app.use("/:sessionId/*", async (c, next) => {
    if (!isSessionId(c.req.param("sessionId"))) return c.json({ error: "Invalid sessionId", code: "INVALID_SESSION_ID" }, 400);
    await next();
  });
  app.get("/", async (c) => c.json({ sessions: await deps.sessions.list() }));
  app.post("/", async (c) => {
    const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid session request", code: "INVALID_REQUEST" }, 400);
    return c.json({ session: await deps.sessions.create(parsed.data.title) });
  });
  app.get("/:sessionId", async (c) => {
    const session = await deps.sessions.get(c.req.param("sessionId"));
    return session ? c.json({ session }) : c.json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
  });
  app.patch("/:sessionId", async (c) => {
    const parsed = renameSessionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid title", code: "INVALID_REQUEST" }, 400);
    return c.json({ session: await deps.sessions.rename(c.req.param("sessionId"), parsed.data.title) });
  });
  app.post("/:sessionId/reset", async (c) => {
    const parsed = resetSessionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid reset request", code: "INVALID_REQUEST" }, 400);
    const id = c.req.param("sessionId");
    const before = (await deps.actions.snapshotPending()).filter((a) => a.sessionId === id).map((a) => a.id);
    const session = await deps.sessions.reset(id);
    const cancelled = await Promise.all(before.map((actionId) => deps.actions.get(actionId)));
    return c.json({ session, cancelledApprovals: cancelled.filter((a) => a?.status === "cancelled").length });
  });
  app.get("/:sessionId/schedules", async (c) => c.json(await deps.sessions.schedules(c.req.param("sessionId"))));
  app.delete("/:sessionId", async (c) => {
    const parsed = deleteSessionSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid session deletion request", code: "INVALID_REQUEST" }, 400);
    const { scheduleDisposition, scheduleRevision } = parsed.data;
    return c.json({ ok: true, ...await deps.sessions.remove(c.req.param("sessionId"), scheduleDisposition, scheduleRevision) });
  });
  return app;
};
