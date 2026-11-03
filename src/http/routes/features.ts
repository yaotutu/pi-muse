import { Hono, type Context } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { FEATURE_AGENTS } from "../../features/agent-extensions/types.js";
import { InformationError } from "../../features/information/errors.js";
import { featureBindingRequest, newsDiscussionRequest } from "../contracts/features.js";
import * as info from "../contracts/information.js";

/** 功能 facade 不接受客户端提供内部智能体；只能操作固定新闻/短信域。 */
export const createFeatureRoutes = ({ features, information }: HttpDependencies) => {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof InformationError) return c.json({ error: error.message, code: error.code }, error.code === "INVALID_INPUT" ? 400 : error.code === "NOT_FOUND" || error.code === "AGENT_NOT_FOUND" ? 404 : error.code === "SHUTDOWN" ? 503 : 409);
    throw error;
  });
  const invalid = (c: Context) => c.json({ error: "Invalid feature request", code: "INVALID_INPUT" }, 400);
  const query = (c: Context) => {
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return undefined;
    return Object.fromEntries(params);
  };
  app.get("/", async (c) => c.json(await features.list()));
  app.put("/:featureId/binding", async (c) => {
    const parsed = featureBindingRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c);
    return c.json(await features.bind(c.req.param("featureId"), parsed.data.agentId));
  });
  app.post("/news/discussions", async (c) => {
    const parsed = newsDiscussionRequest.safeParse(await c.req.json().catch(() => undefined));
    return parsed.success ? c.json(await features.discussNews(parsed.data.articleId)) : invalid(c);
  });
  const agentId = FEATURE_AGENTS.sms;
  app.get("/sms/settings", async (c) => c.json(await information.getSettings(agentId)));
  app.put("/sms/settings", async (c) => {
    const parsed = info.informationSettingsRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c);
    const pause = information.pauseAgent(agentId);
    try { await pause.stopped; return c.json(await information.saveSettings(agentId, parsed.data)); } finally { pause.resume(); }
  });
  app.get("/sms/preferences", async (c) => c.json(await information.getPreferences(agentId)));
  app.put("/sms/preferences", async (c) => {
    const parsed = info.informationPreferencesRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return invalid(c);
    await information.savePreferences(agentId, parsed.data);
    return c.json(await information.getPreferences(agentId));
  });
  app.get("/sms/items", async (c) => {
    const parsed = info.informationItemsQuerySchema.safeParse(query(c));
    return parsed.success ? c.json(await information.listItems(agentId, parsed.data)) : invalid(c);
  });
  app.post("/sms/items", async (c) => {
    const parsed = info.informationIngestRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success || parsed.data.items.some((item) => item.source !== "sms")) return invalid(c);
    return c.json({ items: await information.ingest(agentId, parsed.data.items) });
  });
  app.post("/sms/runs", async (c) => {
    const parsed = info.informationRunRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    return parsed.success ? c.json(await information.runNow(agentId)) : invalid(c);
  });
  app.get("/sms/runs", async (c) => {
    const parsed = info.informationRunsQuerySchema.safeParse(query(c));
    return parsed.success ? c.json(await information.listRuns(agentId, parsed.data)) : invalid(c);
  });
  return app;
};
