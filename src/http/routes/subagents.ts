import { Hono, type Context } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { SubagentError } from "../../features/subagents/registry.js";

const failure = (error: unknown) => {
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

/** 统一专职 Subagent 只读检视路由（/api/subagents）。 */
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

  return app;
};
