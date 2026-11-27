import { Hono, type Context } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { McpError } from "../../features/mcp/types.js";
import { SubagentError } from "../../features/subagents/registry.js";
import { subagentMcpUpdateRequestSchema } from "../contracts/subagents.js";

const failure = (error: unknown) => {
  if (error instanceof McpError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
    } as const;
  }
  if (error instanceof SubagentError) {
    const status =
      error.code === "INVALID_INPUT" ? 400
      : error.code === "NOT_FOUND" ? 404
      : 503;
    return {
      status,
      body: { error: error.message, code: error.code },
    } as const;
  }
  return undefined;
};

/** 统一专职 Subagent 检视与 MCP 选用路由（/api/subagents）。 */
export const createSubagentRoutes = (dependencies: Pick<HttpDependencies, "subagents">) => {
  const { subagents } = dependencies;
  const app = new Hono();

  const handle = async (c: Context, work: () => Promise<unknown>) => {
    try {
      return c.json(await work());
    } catch (error) {
      const mapped = failure(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
  };

  app.get("/", (c) => handle(c, () => subagents.list()));
  app.get("/:id", (c) => handle(c, () => subagents.getDetail(c.req.param("id"))));
  app.get("/:id/mcp", (c) => handle(c, () => subagents.getMcpSelection(c.req.param("id"))));
  app.put("/:id/mcp", (c) =>
    handle(c, async () => {
      const parsed = subagentMcpUpdateRequestSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) {
        throw new SubagentError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid MCP selection");
      }
      return subagents.updateMcpSelection(c.req.param("id"), parsed.data.servers);
    }),
  );

  return app;
};
