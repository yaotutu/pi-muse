import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { AgentCommunicationError } from "../../features/agent-communication/service.js";
import { FeatureError } from "../../features/agent-extensions/types.js";
import { groupSendSchema, groupSettingsSchema } from "../contracts/group-chat.js";

export const createGroupChatRoutes = ({ group, groupRouting }: HttpDependencies) => {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof AgentCommunicationError) return c.json({ error: error.message, code: error.code }, error.code === "BUSY" ? 409 : error.code === "NOT_FOUND" ? 404 : 400);
    throw error;
  });
  app.get("/", async (c) => c.json(await group.snapshot()));
  app.get("/settings", async (c) => c.json(await groupRouting.settings()));
  app.put("/settings", async (c) => {
    const parsed = groupSettingsSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid group settings", code: "INVALID_INPUT" }, 400);
    if (group.busy()) throw new AgentCommunicationError("BUSY", "Group is processing a message");
    return c.json(await groupRouting.saveSettings(parsed.data));
  });
  app.post("/messages", async (c) => {
    const input = groupSendSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) return c.json({ error: "Invalid group message", code: "INVALID_INPUT" }, 400);
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      stream.onAbort(abort);
      c.req.raw.signal.addEventListener("abort", abort, { once: true });
      if (c.req.raw.signal.aborted) abort();
      let writes = Promise.resolve();
      const emit = (value: unknown) => { writes = writes.then(async () => { if (!controller.signal.aborted) await stream.writeSSE({ data: JSON.stringify(value) }); }).catch(abort); };
      try { await group.send(input.data, controller.signal, emit); }
      catch (error) {
        const known = error instanceof AgentCommunicationError || error instanceof FeatureError;
        emit({ type: "error", code: known ? error.code : "GROUP_ERROR", message: known ? error.message : "Unable to process group message" });
      }
      finally { await writes; c.req.raw.signal.removeEventListener("abort", abort); }
    });
  });
  app.post("/messages/:id/stop", (c) => c.json({ stopped: group.stop(c.req.param("id")) }));
  return app;
};
