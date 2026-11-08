import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
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
    error.code === "SESSION_NOT_FOUND" || error.code === "NOT_FOUND" ? 404 :
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

/** 信息后台 HTTP 入口：所有入口都只针对已存在会话，不隐式创建。 */
export const createInformationRoutes = (dependencies: HttpDependencies) => {
  const app = new Hono();
  const { information } = dependencies;

  app.put("/settings", async (c) => {
    const parsed = informationSettingsRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information settings", code: "INVALID_REQUEST" }, 400);
    try {
      const pause = information.pause();
      await pause.stopped;
      try { return c.json(await information.saveSettings(parsed.data)); }
      finally { pause.resume(); }
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/settings", async (c) => {
    try {
      return c.json(await information.getSettings());
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.put("/preferences", async (c) => {
    const parsed = informationPreferencesRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information preferences", code: "INVALID_REQUEST" }, 400);
    try {
      await information.savePreferences(parsed.data);
      return c.json(await information.getPreferences());
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/preferences", async (c) => {
    try {
      return c.json(await information.getPreferences());
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.post("/items", async (c) => {
    const parsed = informationIngestRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information items", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json({ items: await information.ingest(parsed.data.items) });
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/items", async (c) => {
    const parsed = parseQuery(informationItemsQuerySchema, c.req.url);
    if (!parsed.success) return c.json({ error: "Invalid information items query", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.listItems(parsed.data));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/items/:itemId", async (c) => {
    try {
      return c.json(await information.getItem(c.req.param("itemId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.post("/runs", async (c) => {
    const parsed = informationRunRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid information run request", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.runNow());
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/runs", async (c) => {
    const parsed = parseQuery(informationRunsQuerySchema, c.req.url);
    if (!parsed.success) return c.json({ error: "Invalid information runs query", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.listRuns(parsed.data));
    } catch (error) {
      if (error instanceof InformationError) {
        const result = failure(error);
        return c.json(result.body, result.status);
      }
      throw error;
    }
  });

  app.get("/runs/:runId", async (c) => {
    try {
      return c.json(await information.getRun(c.req.param("runId")));
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
