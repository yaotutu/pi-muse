import { Hono } from "hono";
import { z } from "zod";
import type { HttpDependencies } from "../../bootstrap/types.js";
import { traceFileNameSchema } from "../../adapters/model-trace/schema.js";
import { tracesQuerySchema, traceTimeMs, type TraceSummaryDto } from "../contracts/traces.js";

// 游标仅持有文件锚点和标准化过滤条件，不复制正文或新增分页存储。
const cursorSchema = z.strictObject({
  fileName: traceFileNameSchema,
  filter: z.string(),
});
export const createTracesRoutes = ({ traces }: Pick<HttpDependencies, "traces">) => {
  const app = new Hono();
  app.get("/api/traces", async (c) => {
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(c.req.url).searchParams) {
      if (Object.hasOwn(raw, key)) return c.json({ error: "Duplicate trace query parameter", code: "INVALID_REQUEST" }, 400);
      raw[key] = value;
    }
    const parsed = tracesQuerySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid trace query", code: "INVALID_REQUEST" }, 400);
    const { sessionId, kind, since, until, limit, cursor } = parsed.data;
    const from = since === undefined ? null : traceTimeMs(since);
    const to = until === undefined ? null : traceTimeMs(until);
    if (from !== null && to !== null && from > to) return c.json({ error: "Invalid trace time range", code: "INVALID_REQUEST" }, 400);
    const filter = JSON.stringify([sessionId ?? null, kind ?? null, from, to]);
    let anchor: string | undefined;
    if (cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid cursor encoding");
        const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
        if (decoded.filter !== filter) throw new Error("Mismatched cursor");
        anchor = decoded.fileName;
      } catch {
        return c.json({ error: "Invalid trace cursor", code: "INVALID_CURSOR" }, 400);
      }
    }
    const { records, badCount } = await traces.list();
    const matching = records.filter(({ record: { meta } }) => {
      const startedAt = Date.parse(meta.startedAt);
      return (sessionId === undefined || meta.sessionId === sessionId) && (kind === undefined || meta.kind === kind)
        && (from === null || startedAt >= from) && (to === null || startedAt <= to);
    }).sort((a, b) => Date.parse(b.record.meta.startedAt) - Date.parse(a.record.meta.startedAt) || b.fileName.localeCompare(a.fileName));
    const anchorIndex = anchor === undefined ? -1 : matching.findIndex((entry) => entry.fileName === anchor);
    // 文件名在请求结束时生成，不必等同 startedAt 顺序；以实际排序中的文件锚点翻页。
    // 保留清理删除锚点后明确要求重读，不按文件名猜测并静默漏条。
    if (anchor !== undefined && anchorIndex < 0) return c.json({ error: "Trace cursor anchor no longer exists; restart pagination", code: "INVALID_CURSOR" }, 400);
    const selected = matching.slice(anchorIndex + 1, anchorIndex + 1 + limit);
    const hasMore = anchorIndex + 1 + selected.length < matching.length;
    const summaries: TraceSummaryDto[] = selected.map(({ fileName, record }) => ({
      fileName, meta: record.meta,
      systemChars: record.request?.system.length ?? 0,
      messageCount: record.request?.messages.length ?? 0,
      toolCount: record.request?.tools.length ?? 0,
      outputChars: record.response?.outputText.length ?? 0,
      truncated: record.response?.truncated ?? false,
      disconnected: record.response?.disconnected ?? false,
      failure: record.response?.failure !== undefined,
    }));
    return c.json({ traces: summaries, badCount, hasMore, nextCursor: hasMore
      ? Buffer.from(JSON.stringify({ fileName: selected.at(-1)!.fileName, filter })).toString("base64url") : null });
  });

  app.get("/api/traces/:fileName", async (c) => {
    const fileName = c.req.param("fileName");
    if (!traceFileNameSchema.safeParse(fileName).success) return c.json({ error: "Invalid trace file name", code: "INVALID_REQUEST" }, 400);
    const record = await traces.read(fileName);
    return record ? c.json({ fileName, ...record }) : c.json({ error: "Trace not found", code: "TRACE_NOT_FOUND" }, 404);
  });
  // 两段式访问与单段标识使用同一校验/读取边界，无通配路径或隐藏端点。
  app.get("/api/traces/:day/:fileName", async (c) => {
    const day = c.req.param("day");
    const name = c.req.param("fileName");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^[A-Za-z0-9._-]+$/.test(name))
      return c.json({ error: "Invalid trace file name", code: "INVALID_REQUEST" }, 400);
    const fileName = `${day}.${name}`;
    if (!traceFileNameSchema.safeParse(fileName).success) return c.json({ error: "Invalid trace file name", code: "INVALID_REQUEST" }, 400);
    const record = await traces.read(fileName);
    return record ? c.json({ fileName, ...record }) : c.json({ error: "Trace not found", code: "TRACE_NOT_FOUND" }, 404);
  });
  return app;
};
