import { ConversationError } from "../../features/conversation/errors.js";
import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { conversationQuerySchema } from "../contracts/rest.js";

/** 会话历史（agentId 查询参数选择，缺省主智能体）。历史只读，回写端点已移除。 */
export const createConversationRoutes = (
  dependencies: Pick<HttpDependencies, "conversationHub">,
) => {
  const { conversationHub } = dependencies;
  const app = new Hono();
  app.get("/api/conversation", async (c) => {
    const parsed = conversationQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid conversation query", code: "INVALID_REQUEST" }, 400);
    const { agentId } = parsed.data;
    try {
      const conversation = await conversationHub.findAgent(agentId);
      return c.json(
        conversation
          ? await conversation.snapshot()
          : { sessionId: null, messages: [], revision: "empty" },
      );
    } catch (error) {
      if (error instanceof ConversationError && error.code === "UNSUPPORTED_AGENT")
        return c.json({ error: "Invalid agentId", code: "INVALID_AGENT_ID" }, 400);
      throw error;
    }
  });
  return app;
};
