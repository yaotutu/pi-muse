import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { SpaceCommunicationError } from "../../features/space-communication/service.js";
import { groupSendSchema } from "../contracts/group-chat.js";

export const createGroupChatRoutes = ({ group }: HttpDependencies) => {
  const app = new Hono();
  app.get("/", async (c) => c.json(await group.snapshot()));
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
      catch (error) { emit({ type: "error", code: error instanceof SpaceCommunicationError ? error.code : "GROUP_ERROR", message: error instanceof SpaceCommunicationError ? error.message : "Unable to process group message" }); }
      finally { await writes; c.req.raw.signal.removeEventListener("abort", abort); }
    });
  });
  app.post("/messages/:id/stop", (c) => c.json({ stopped: group.stop(c.req.param("id")) }));
  return app;
};
