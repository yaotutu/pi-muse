import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { isAgentId } from "../../features/conversation/agent-id.js";
import { InformationError } from "../../features/information/errors.js";
import {
  informationIngestRequestSchema,
  informationItemsQuerySchema,
  informationPreferencesRequestSchema,
  informationRunsQuerySchema,
  informationRunRequestSchema,
  informationSettingsRequestSchema,
} from "../contracts/information.js";

const failure = (error: InformationError) => {
  const status =
    error.code === "INVALID_INPUT" ? 400 :
    error.code === "AGENT_NOT_FOUND" || error.code === "NOT_FOUND" ? 404 :
    error.code === "SHUTDOWN" ? 503 : 409;
  return {
    status,
    body: { error: error.message, code: error.code },
  } as const;
};

const parseQuery = <T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  url: string,
) => {
  const query = new URL(url).searchParams;
  for (const key of new Set(query.keys())) {
    if (query.getAll(key).length > 1) return { success: false as const };
  }
  return schema.safeParse(Object.fromEntries(query.entries()));
};

/** 信息后台 HTTP 入口：所有入口都只针对已存在智能体，不隐式创建。 */
export const createInformationRoutes = (dependencies: HttpDependencies) => {
  const app = new Hono();
  const { conversationHub, information } = dependencies;

  const guard = (agentId: string, code = "INVALID_AGENT_ID") => {
    if (!isAgentId(agentId)) return { status: 400 as const, body: { error: "Invalid agentId", code } } as const;
    return undefined;
  };

  app.put("/:agentId/information/settings", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = informationSettingsRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information settings", code: "INVALID_REQUEST" }, 400);
    try {
      const agentId = c.req.param("agentId");
      const pause = information.pauseAgent(agentId);
      await pause.stopped;
      try {
        const saved = await conversationHub.withExistingAgent(agentId, async () =>
          information.saveSettings(agentId, parsed.data));
        if (!saved) return c.json({ error: "Agent not found", code: "AGENT_NOT_FOUND" }, 404);
        return c.json(saved);
      } finally {
        pause.resume();
      }
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:agentId/information/settings", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    try {
      return c.json(await information.getSettings(c.req.param("agentId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.put("/:agentId/information/preferences", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = informationPreferencesRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information preferences", code: "INVALID_REQUEST" }, 400);
    try {
      const agentId = c.req.param("agentId");
      const saved = await conversationHub.withExistingAgent(agentId, async () => {
        await information.savePreferences(agentId, parsed.data);
        return true;
      });
      if (saved !== true) return c.json({ error: "Agent not found", code: "AGENT_NOT_FOUND" }, 404);
      // getPreferences 需要 retain 智能体；不能嵌套在同一个短生命周期锁内。
      return c.json(await information.getPreferences(agentId));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:agentId/information/preferences", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    try {
      return c.json(await information.getPreferences(c.req.param("agentId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.post("/:agentId/information/items", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = informationIngestRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information items", code: "INVALID_REQUEST" }, 400);
    try {
      const result = await conversationHub.withExistingAgent(c.req.param("agentId"), async () =>
        information.ingest(c.req.param("agentId"), parsed.data.items));
      if (!result) return c.json({ error: "Agent not found", code: "AGENT_NOT_FOUND" }, 404);
      return c.json({ items: result });
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:agentId/information/items", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = parseQuery(informationItemsQuerySchema, c.req.url);
    if (!parsed.success) return c.json({ error: "Invalid information items query", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.listItems(c.req.param("agentId"), parsed.data));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:agentId/information/items/:itemId", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    try {
      return c.json(await information.getItem(c.req.param("agentId"), c.req.param("itemId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.post("/:agentId/information/runs", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = informationRunRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid information run request", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.runNow(c.req.param("agentId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:agentId/information/runs", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    const parsed = parseQuery(informationRunsQuerySchema, c.req.url);
    if (!parsed.success) return c.json({ error: "Invalid information runs query", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.listRuns(c.req.param("agentId"), parsed.data));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/:agentId/information/runs/:runId", async (c) => {
    const invalid = guard(c.req.param("agentId"));
    if (invalid) return c.json(invalid.body, invalid.status);
    try {
      return c.json(await information.getRun(c.req.param("agentId"), c.req.param("runId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  return app;
};
