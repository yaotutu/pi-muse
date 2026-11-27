import { Hono, type Context } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { McpError } from "../../features/mcp/types.js";
import { mcpServerPatchRequest, mcpServerUpsertRequest } from "../contracts/mcp.js";

const failure = (error: unknown) => {
  if (error instanceof McpError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
    } as const;
  }
  return undefined;
};

/** 标准 MCP 托管与运维路由（/api/mcp/servers*）。 */
export const createMcpRoutes = (dependencies: Pick<HttpDependencies, "mcp">) => {
  const { mcp } = dependencies;
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

  app.get("/servers", (c) => handle(c, () => mcp.list()));
  app.get("/servers/:name", (c) => handle(c, async () => ({ server: await mcp.get(c.req.param("name")) })));
  app.put("/servers/:name", (c) =>
    handle(c, async () => {
      const parsed = mcpServerUpsertRequest.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) {
        throw new McpError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid MCP server config", 400);
      }
      return { server: await mcp.upsert(c.req.param("name"), parsed.data) };
    }),
  );
  app.patch("/servers/:name", (c) =>
    handle(c, async () => {
      const parsed = mcpServerPatchRequest.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) {
        throw new McpError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Invalid MCP patch", 400);
      }
      return { server: await mcp.patch(c.req.param("name"), parsed.data) };
    }),
  );
  app.delete("/servers/:name", (c) => handle(c, () => mcp.remove(c.req.param("name"))));
  app.post("/servers/:name/reconnect", (c) =>
    handle(c, async () => ({ server: await mcp.reconnect(c.req.param("name")) })),
  );

  return app;
};
