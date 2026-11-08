import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { SessionError } from "../../features/sessions/types.js";
import { isSessionId, sessionInstructionsFile } from "../../adapters/storage/data-layout.js";
import { readSessionInstructions, writeSessionInstructions } from "../../adapters/storage/session-instructions.js";
import { createSessionSchema, renameSessionSchema, resetSessionSchema, saveInstructionsSchema, updateSkillsSchema } from "../contracts/rest.js";

/** 会话生命周期与配置入口；不接纳客户端提供的公开 id，不隐式创建会话。 */
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
    const parsed = resetSessionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid reset request", code: "INVALID_REQUEST" }, 400);
    const id = c.req.param("sessionId");
    const before = (await deps.actions.snapshotPending()).filter((a) => a.sessionId === id).map((a) => a.id);
    const jobsBefore = (await deps.jobs.list()).filter((j) => j.originSessionId === id).length;
    const monitorsBefore = (await deps.monitors.list()).filter((m) => m.originSessionId === id).length;
    const session = await deps.sessions.reset(id, parsed.data);
    const cancelled = await Promise.all(before.map((actionId) => deps.actions.get(actionId)));
    return c.json({ session, cancelledApprovals: cancelled.filter((a) => a?.status === "cancelled").length,
      removed: { jobs: parsed.data.clearSchedules ? jobsBefore : 0, monitors: parsed.data.clearSchedules ? monitorsBefore : 0 } });
  });
  app.delete("/:sessionId", async (c) => c.json({ ok: true, ...await deps.sessions.remove(c.req.param("sessionId")) }));
  const existing = async <T>(id: string, change: () => Promise<T>) => {
    const value = await deps.conversationHub.withExistingSession(id, change);
    if (value === undefined) throw new SessionError(404, "SESSION_NOT_FOUND", "Session not found");
    return value;
  };
  app.get("/:sessionId/instructions", async (c) => c.json(await existing(c.req.param("sessionId"), async () => ({ instructions: await readSessionInstructions(sessionInstructionsFile(deps.layout, c.req.param("sessionId"))) }))));
  app.put("/:sessionId/instructions", async (c) => {
    const parsed = saveInstructionsSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid instructions", code: "INVALID_REQUEST" }, 400);
    return c.json(await existing(c.req.param("sessionId"), async () => {
      await writeSessionInstructions(sessionInstructionsFile(deps.layout, c.req.param("sessionId")), parsed.data.instructions);
      return { instructions: parsed.data.instructions.trim() };
    }));
  });
  app.get("/:sessionId/skills", async (c) => c.json(await existing(c.req.param("sessionId"), () => deps.skills.describeSession(c.req.param("sessionId")))));
  app.put("/:sessionId/skills", async (c) => {
    const parsed = updateSkillsSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid skills", code: "INVALID_REQUEST" }, 400);
    return c.json(await existing(c.req.param("sessionId"), async () => {
      await deps.skills.updateSessionOverrides(c.req.param("sessionId"), parsed.data.overrides);
      return deps.skills.describeSession(c.req.param("sessionId"));
    }));
  });
  return app;
};
