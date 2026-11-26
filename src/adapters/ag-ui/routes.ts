import type { BaseEvent } from "@ag-ui/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { runRequestSchema, stopRequestSchema } from "../../http/contracts/rest.js";
import { sessionStatusQuery } from "../../http/contracts/session-status.js";
import type { SessionHub } from "../../features/conversation/conversation-hub.js";
import type { ConversationStreamHandle } from "../../features/conversation/conversation-service.js";
import { ConversationError } from "../../features/conversation/errors.js";
import type { ConversationEvent } from "../../features/conversation/types.js";
import { createEventProjector } from "./events.js";
import type { ToolPresentation } from "./tool-presentation.js";

const conversationErrorResponse = (c: Context, error: unknown) => {
  if (!(error instanceof ConversationError)) throw error;
  const status = error.code === "SHUTDOWN" || error.code === "MODEL_NOT_CONFIGURED" ? 503
    : error.code === "SESSION_NOT_FOUND" ? 404
    : error.code === "INVALID_INPUT" || error.code === "UNSUPPORTED_SESSION" ? 400 : 409;
  return c.json({ error: error.message, code: error.code }, status);
};

/**
 * 自有 HTTP 输入与 AG-UI 输出之间的薄适配层，不需要 runtime/agent 宿主。
 * 协调器仍独占运行锁；客户端断开 HTTP 流只解除本次流订阅，不会取消服务端运行。
 * 只有显式 Stop（绑定 runId）、超时、会话重置/删除或服务关闭才中止执行。
 */
export const createAgUiRoutes = (hub: SessionHub, presentation: ToolPresentation) => {
  const app = new Hono();
  const serveEventStream = (
    c: Context,
    open: (emit: (event: ConversationEvent) => void) => ConversationStreamHandle | null,
  ) => {
    const pendingWrites: BaseEvent[] = [];
    let sink: ((event: BaseEvent) => void) | undefined;
    let closed = false;
    let resolveDetached!: () => void;
    const detached = new Promise<void>((resolve) => { resolveDetached = resolve; });
    let handle: ConversationStreamHandle | null = null;
    const detach = () => {
      if (closed) return;
      closed = true;
      handle?.detach();
      resolveDetached();
    };
    const emit = createEventProjector((event) => {
      if (sink) sink(event);
      else pendingWrites.push(event);
    }, presentation);
    handle = open(emit);
    if (!handle) return null;
    const current = handle;
    return streamSSE(c, async (stream) => {
      let writes = Promise.resolve();
      const writeEvent = (event: BaseEvent) => {
        writes = writes.then(async () => {
          if (!closed) await stream.writeSSE({ data: JSON.stringify(event) });
        }).catch(detach);
      };
      c.req.raw.signal.addEventListener("abort", detach, { once: true });
      stream.onAbort(detach);
      if (c.req.raw.signal.aborted) detach();
      sink = writeEvent;
      for (const event of pendingWrites.splice(0)) writeEvent(event);
      try {
        await Promise.race([current.done, detached]);
      } finally {
        current.detach();
        c.req.raw.signal.removeEventListener("abort", detach);
        if (!closed) await writes;
      }
    });
  };
  // 附件随 run JSON 一次性提交；此路由必须先于全局 1MiB 限制获得专用上限。
  app.use("/api/conversation/run", bodyLimit({
    maxSize: 12 * 1024 * 1024,
    onError: (c) => c.json({ error: "Conversation request body exceeds 12 MiB", code: "REQUEST_TOO_LARGE" }, 413),
  }));
  app.post("/api/conversation/run", async (c) => {
    const parsed = runRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid conversation request", code: "INVALID_INPUT" }, 400);
    const input = parsed.data;
    const sessionId = input.sessionId || "main";
    try {
      const conversation = await hub.forSession(sessionId);
      const normalized = { ...input, sessionId };
      conversation.validate(normalized);
      return serveEventStream(c, (emit) => conversation.startRun(normalized, emit))!;
    } catch (error) {
      return conversationErrorResponse(c, error);
    }
  });
  app.get("/api/conversation/stream", async (c) => {
    const parsed = sessionStatusQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid stream query", code: "INVALID_REQUEST" }, 400);
    try {
      const conversation = await hub.findSession(parsed.data.sessionId);
      if (!conversation) return c.json({ error: "Active run not found", code: "NOT_FOUND" }, 404);
      const response = serveEventStream(c, (emit) => conversation.attachStream(parsed.data.runId, emit));
      return response ?? c.json({ error: "Active run not found", code: "NOT_FOUND" }, 404);
    } catch (error) {
      return conversationErrorResponse(c, error);
    }
  });
  app.post("/api/conversation/stop", async (c) => {
    const parsed = stopRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "Invalid stop request" }, 400);
    const sessionId = parsed.data.sessionId || "main";
    const conversation = await hub.findSession(sessionId);
    return c.json({ stopped: await conversation?.cancel("STOPPED", parsed.data.runId) ?? false });
  });
  return app;
};
