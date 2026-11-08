import { z } from "zod";
import { modelTraceKindSchema, modelTraceRecordSchema, traceFileNameSchema } from "../../adapters/model-trace/schema.js";

/** 诊断接口不向模型开放；复用只读 adapter 的记录校验，避免一期格式与 HTTP 详情漂移。 */
export const traceKinds = modelTraceKindSchema.options;
export const traceSummarySchema = z.object({
  fileName: traceFileNameSchema,
  meta: modelTraceRecordSchema.shape.meta,
  systemChars: z.number().int().nonnegative().describe("system 文本 UTF-16 字符数；无请求时为 0"),
  messageCount: z.number().int().nonnegative().describe("请求 messages 数量，包含 system 与工具消息"),
  toolCount: z.number().int().nonnegative().describe("请求工具声明数量"),
  outputChars: z.number().int().nonnegative().describe("response.outputText UTF-16 字符数，不含工具参数或错误正文"),
  truncated: z.boolean().describe("响应捕获是否截断；无响应为 false"),
  disconnected: z.boolean().describe("是否提前断开；未标记为 false"),
  failure: z.boolean().describe("是否存在 response.failure；HTTP 非 2xx 单独查看 httpStatus"),
});
export const tracesResponse = z.object({
  traces: z.array(traceSummarySchema).describe("按 meta.startedAt 倒序，同时间按 fileName 倒序；不含请求/响应正文"),
  badCount: z.number().int().nonnegative().describe("本次全目录扫描跳过的损坏或不可读条目数，不按过滤条件缩减"),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable().describe("下一页不透明游标，绑定 sessionId/kind/since/until；无下一页为 null"),
}).describe("只读分页，不冻结快照；新记录出现在第一页。关闭记录或目录不存在返回空集。单条损坏不使整页失败。");
export const traceDetailResponse = z.object({ fileName: traceFileNameSchema, ...modelTraceRecordSchema.shape })
  .describe("完整单条 trace（已按一期记录规则脱敏），包括请求、响应与全部 meta。不存在、损坏或不可读均返回 404，绝不写回文件。");

/** 数字时间戳明确按 Unix 毫秒；ISO 日期无时区歧义，日期时间必须携带 Z 或偏移。 */
export const traceTimeSchema = z.string().max(64).refine((value) => {
  if (/^\d+$/.test(value)) return Number.isFinite(new Date(Number(value)).getTime());
  if (z.iso.date().safeParse(value).success) return true;
  return z.iso.datetime({ offset: true }).safeParse(value).success;
}, "Expected ISO date/datetime or Unix milliseconds").describe("ISO 日期 YYYY-MM-DD（UTC 零点）、带时区 ISO 时间，或 Unix 毫秒时间戳；边界按 startedAt 包含式过滤。");
export const traceTimeMs = (value: string) => /^\d+$/.test(value) ? Number(value) : Date.parse(value);
export const tracesQuerySchema = z.strictObject({
  sessionId: z.string().min(1).max(256).optional().describe("sessionId 精确匹配；省略则不限，不要求会话仍存在"),
  kind: modelTraceKindSchema.optional().describe("调用场景精确匹配；省略则不限"),
  since: traceTimeSchema.optional(),
  until: traceTimeSchema.optional(),
  cursor: z.string().min(1).max(4096).optional().describe("上一页 nextCursor；更换过滤器必须省略。非法、过滤条件不符或锚点文件已被清理时 400，需从第一页重读。"),
  limit: z.preprocess((value) => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value,
    z.number().int().min(1).max(100).default(20)).describe("每页数量，默认 20，上限 100；只接受十进制整数"),
}).describe("仅允许声明的参数，拒绝重复参数；since > until 返回 400。GET 无副作用。");

export type TraceSummaryDto = z.infer<typeof traceSummarySchema>;
export type TracesResponseDto = z.infer<typeof tracesResponse>;
export type TraceDetailDto = z.infer<typeof traceDetailResponse>;
export type TracesQueryDto = z.infer<typeof tracesQuerySchema>;
