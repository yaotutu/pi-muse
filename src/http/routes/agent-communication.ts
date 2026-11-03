import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { AgentCommunicationError } from "../../features/agent-communication/service.js";
import { agentRequestSchema } from "../contracts/agent-communication.js";

/** API 与模型工具复用同一服务；HTTP 不调度来源会话，不把回复伪装成通知。 */
export const createAgentCommunicationRoutes = ({ communication }: HttpDependencies) => {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof AgentCommunicationError) return c.json({ error: error.message, code: error.code }, error.code === "INVALID_INPUT" ? 400 : error.code === "NOT_FOUND" ? 404 : error.code === "SHUTDOWN" ? 503 : 409);
    throw error;
  });
  app.post("/requests", async (c) => {
    const parsed = agentRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid agent request", code: "INVALID_INPUT" }, 400);
    return c.json(await communication.request(parsed.data, c.req.raw.signal));
  });
  app.get("/discussions/:targetAgentId/:discussionId", async (c) => c.json(await communication.history(c.req.param("targetAgentId"), c.req.param("discussionId"))));
  return app;
};
