import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { InformationError } from "../../features/information/errors.js";
import {
  informationArchiveIngestRequestSchema,
  informationArchiveRunRequestSchema,
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

/** 信息后台 HTTP 入口：实时单周期与历史归档两条路径隔离，共用用户指令、长期行为习惯与未消化反馈热缓冲。 */
export const createInformationRoutes = (dependencies: HttpDependencies) => {
  const app = new Hono();
  const { information } = dependencies;

  app.put("/settings", async (c) => {
    const parsed = informationSettingsRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information settings", code: "INVALID_REQUEST" }, 400);
    try {
      const pause = information.pause();
      await pause.stopped;
      try {
        return c.json(await information.saveSettings(parsed.data));
      } finally {
        pause.resume();
      }
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  app.get("/settings", async (c) => {
    try {
      return c.json(await information.getSettings());
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  app.put("/preferences", async (c) => {
    const parsed = informationPreferencesRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid information preferences", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.savePreferences(parsed.data));
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  app.get("/preferences", async (c) => {
    try {
      return c.json(await information.getPreferences());
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
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
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  app.post("/archive/items", async (c) => {
    const parsed = informationArchiveIngestRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid archive information items", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.ingestArchive(parsed.data.items));
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  app.post("/archive/run", async (c) => {
    const parsed = informationArchiveRunRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid archive run request", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.runArchive(parsed.data));
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
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
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  app.get("/items/:itemId", async (c) => {
    try {
      return c.json(await information.getItem(c.req.param("itemId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  app.get("/status", async (c) => {
    try {
      return c.json(await information.getStatus());
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  app.post("/runs", async (c) => {
    const rawBody = await c.req.text();
    let payload: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return c.json({ error: "Invalid information run request", code: "INVALID_REQUEST" }, 400);
      }
    }
    const parsed = informationRunRequestSchema.safeParse(payload);
    if (!parsed.success) return c.json({ error: "Invalid information run request", code: "INVALID_REQUEST" }, 400);
    try {
      return c.json(await information.runNow(parsed.data));
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
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
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  app.get("/runs/:runId", async (c) => {
    try {
      return c.json(await information.getRun(c.req.param("runId")));
    } catch (error) {
      if (error instanceof InformationError) {
        const mapped = failure(error);
        return c.json(mapped.body, mapped.status);
      }
      throw error;
    }
  });

  return app;
};
