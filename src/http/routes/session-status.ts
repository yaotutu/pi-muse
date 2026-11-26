import { Buffer } from "node:buffer";
import { Hono } from "hono";
import type { HttpDependencies } from "../../bootstrap/types.js";
import {
  runCursorPayloadSchema,
  runListQuery,
  sessionStatusQuery,
  type RunCursorPayloadDto,
} from "../contracts/session-status.js";

const parseQueryObject = (url: URL): Record<string, string> | undefined => {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  return values;
};

const encodeRunCursor = (cursor: RunCursorPayloadDto): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

const decodeRunCursor = (value: string): RunCursorPayloadDto | undefined => {
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value) return undefined;
    const parsed = runCursorPayloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** 执行记录与单次运行状态查询（只读，不调用模型、不建立会话或目录）。 */
export const createSessionStatusRoutes = (dependencies: Pick<HttpDependencies, "conversationHub" | "workspaceEvents">) => {
  const app = new Hono();

  app.get("/api/runs", async (c) => {
    const raw = parseQueryObject(new URL(c.req.url));
    if (!raw) return c.json({ error: "Invalid runs query", code: "INVALID_REQUEST" }, 400);
    const parsed = runListQuery.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid runs query", code: "INVALID_REQUEST" }, 400);
    const { sessionId, limit, cursor: encodedCursor } = parsed.data;
    let cursor: RunCursorPayloadDto | undefined;
    if (encodedCursor !== undefined) {
      cursor = decodeRunCursor(encodedCursor);
      if (!cursor || cursor.sessionId !== sessionId) {
        return c.json({ error: "Invalid runs cursor", code: "INVALID_CURSOR" }, 400);
      }
    }
    const conversation = await dependencies.conversationHub.findSession(sessionId);
    const all = conversation?.executionRuns() ?? [];
    const filtered = cursor
      ? all.filter((run) => run.startedAt < cursor.startedAt || (run.startedAt === cursor.startedAt && run.runId < cursor.runId))
      : all;
    const runs = filtered.slice(0, limit);
    const hasMore = filtered.length > runs.length;
    const last = runs.at(-1);
    return c.json({
      instanceId: dependencies.workspaceEvents.instanceId,
      runs,
      hasMore,
      nextCursor: hasMore && last ? encodeRunCursor({ startedAt: last.startedAt, runId: last.runId, sessionId }) : null,
    });
  });

  app.get("/api/runs/status", async (c) => {
    const raw = parseQueryObject(new URL(c.req.url));
    if (!raw) return c.json({ error: "Invalid execution status query", code: "INVALID_REQUEST" }, 400);
    const parsed = sessionStatusQuery.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid execution status query", code: "INVALID_REQUEST" }, 400);
    const sessionId = parsed.data.sessionId;
    const conversation = await dependencies.conversationHub.findSession(sessionId);
    const status = conversation?.executionStatus(parsed.data.runId);
    return status ? c.json({ instanceId: dependencies.workspaceEvents.instanceId, status }) : c.json({ error: "Execution status not found", code: "NOT_FOUND" }, 404);
  });

  return app;
};
