import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { SpaceCommunicationError } from "../../features/space-communication/service.js";
import { spaceRequestSchema } from "../contracts/space-communication.js";

/** API 与模型工具复用同一服务；HTTP 不调度来源会话，不把回复伪装成通知。 */
export const createSpaceCommunicationRoutes = ({ communication }: HttpDependencies) => {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof SpaceCommunicationError) return c.json({ error: error.message, code: error.code }, error.code === "INVALID_INPUT" ? 400 : error.code === "NOT_FOUND" ? 404 : error.code === "SHUTDOWN" ? 503 : 409);
    throw error;
  });
  app.get("/spaces", async (c) => c.json(await communication.listSpaces()));
  app.post("/requests", async (c) => {
    const parsed = spaceRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid space request", code: "INVALID_INPUT" }, 400);
    return c.json(await communication.request(parsed.data, c.req.raw.signal));
  });
  app.get("/discussions/:targetSpaceId/:discussionId", async (c) => c.json(await communication.history(c.req.param("targetSpaceId"), c.req.param("discussionId"))));
  return app;
};
