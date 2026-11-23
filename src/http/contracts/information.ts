import { z } from "zod";
import { isWorkspaceText } from "../../shared/workspace-text.js";
import { habitItemSchema } from "./habits.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const informationSourceSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_-]{0,127}$/,
  "source must be an ASCII identifier",
);
export const informationExternalIdSchema = z.string().trim().min(1).max(256).refine(isWorkspaceText, "Invalid externalId");

export const informationSettingsSchema = z.strictObject({
  enabled: z.boolean().describe("是否启用日常实时短信后台处理"),
  batchWindowSeconds: z.number().int().min(0).max(3600).describe("实时队列接收新消息后的静默合并等待秒数；0 表示下一调度周期立即触发"),
});

export const informationSettingsRequestSchema = informationSettingsSchema;
export const informationSettingsResponse = informationSettingsSchema;

export const informationFeedbackExampleResponse = z.strictObject({
  runId: z.string(),
  notificationId: z.string(),
  text: z.string(),
  reaction: z.enum(["like", "dislike"]).nullable(),
  saved: z.boolean(),
  comments: z.array(z.string()),
  commentsTruncated: z.boolean(),
  items: z.array(z.strictObject({
    id: z.string(),
    source: z.string(),
    title: z.string().optional(),
    content: z.string(),
    contentTruncated: z.boolean(),
  })),
});

export const informationPreferencesRequestSchema = z.strictObject({
  instructions: z.string().max(20_000).refine(isWorkspaceText, "Invalid text").describe("用户主动编写的信息后台指令（domains/sms/INSTRUCTIONS.md）"),
});

export const informationPreferencesResponse = z.strictObject({
  instructions: z.string().describe("用户主动编写的领域指令文本"),
  habits: z.array(habitItemSchema).describe("通用习惯引擎沉淀的行为习惯条文（自动定期从反馈归纳，也可手动增删改）"),
  unconsolidatedFeedbackCount: z.number().int().nonnegative().describe("去重后尚未归纳成长期习惯的近期反馈条数"),
  feedbackExamples: z.array(informationFeedbackExampleResponse).describe("尚未消化进入长期习惯的近期消息反馈热缓冲样本（归纳后自动清空）"),
});

export const informationInputItemSchema = z.strictObject({
  source: informationSourceSchema.describe("ASCII identifier 来源标识（如 sms、webhook、client-device）"),
  externalId: informationExternalIdSchema.describe("客户端去重唯一 ID，同一 (source, externalId) 仅接纳一次"),
  title: z.string().min(1).max(500).refine((v) => v.trim().length > 0 && isWorkspaceText(v), "Invalid title").optional().describe("可选原始标题或发件人摘要，保留原文"),
  content: z.string().min(1).max(20_000).refine((v) => v.trim().length > 0 && isWorkspaceText(v), "Invalid content").describe("原始信息正文，保留原文"),
  receivedAt: z.string().datetime().optional().describe("客户端原始收到时间（ISO 8601）；缺省使用接纳时间"),
});

export const informationIngestRequestSchema = z.strictObject({
  items: z.array(informationInputItemSchema).min(1).max(100).describe("一次提交 1–100 条日常实时信息"),
});

export const informationArchiveIngestRequestSchema = z.strictObject({
  items: z.array(informationInputItemSchema).min(1).max(500).describe("一次提交 1–500 条历史归档信息"),
});

export const informationItemResponseSchema = z.strictObject({
  id: z.string().regex(idPattern),
  queue: z.enum(["realtime", "archive"]).describe("realtime=日常实时队列；archive=历史批量归档队列"),
  source: z.string(),
  externalId: z.string(),
  title: z.string().optional(),
  content: z.string(),
  receivedAt: z.string().datetime(),
  acceptedAt: z.string().datetime(),
  status: z.enum(["pending", "processing", "processed", "failed"]),
  runId: z.string().optional(),
});

export const informationIngestResponse = z.strictObject({
  items: z.array(informationItemResponseSchema),
});

export const informationArchiveIngestResponse = z.strictObject({
  items: z.array(informationItemResponseSchema).describe("本次新接纳的归档条目（已去重）"),
  skippedCount: z.number().int().nonnegative().describe("因重复而跳过的条目数"),
});

export const informationItemsQuerySchema = z.strictObject({
  queue: z.enum(["realtime", "archive"]).optional().describe("按队列过滤：realtime（日常实时）或 archive（历史归档）"),
  status: z.enum(["pending", "processing", "processed", "failed"]).optional().describe("按处理状态过滤；省略返回全部"),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe("返回数量，默认 20，范围 1–100"),
  cursor: z.string().min(1).max(2048).optional().describe("上一页返回的不透明 base64url 游标；过滤条件改变后重新开始"),
});

export const informationItemsResponse = z.strictObject({
  items: z.array(informationItemResponseSchema),
  nextCursor: z.string().optional(),
});

export const informationDecisionSchema = z.strictObject({
  itemId: z.string(),
  decision: z.enum(["silent", "notify"]),
  reason: z.string(),
});

export const informationPublicationSchema = z.strictObject({
  notificationId: z.string().describe("服务端稳定通知 ID（用于消息反馈关联）"),
  itemIds: z.array(z.string()),
  text: z.string().describe("投递到主对话的通知或归档简报正文"),
  status: z.enum(["pending", "published", "failed"]),
  receipt: z.strictObject({
    notificationId: z.string(),
    piSessionId: z.string(),
    messageId: z.string(),
  }).optional(),
  error: z.string().optional(),
});

export const informationRunResponseSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["realtime", "archive"]).describe("realtime=日常单周期；archive=历史批量画像"),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  itemIds: z.array(z.string()),
  model: z.strictObject({
    status: z.enum(["succeeded", "failed"]),
    error: z.string().optional(),
  }).optional(),
  decisions: z.array(informationDecisionSchema).optional(),
  publications: z.array(informationPublicationSchema),
});

export const informationItemDetailResponse = z.strictObject({
  item: informationItemResponseSchema,
  runs: z.array(informationRunResponseSchema),
});

export const informationRunRequestSchema = z.strictObject({});

export const informationArchiveRunRequestSchema = z.strictObject({
  background: z.boolean().default(false).describe("true 立即异步后台运行；false 同步运行直到归档队列清零或失败"),
  retryFailed: z.boolean().default(false).describe("true 先把失败归档条目重置为 pending 再继续执行"),
});

export const informationArchiveRunResponse = z.strictObject({
  status: z.enum(["started", "completed", "partial"]),
  runsCount: z.number().int().nonnegative(),
  processedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  remainingPendingCount: z.number().int().nonnegative(),
  briefingPublished: z.boolean(),
});

export const informationRunsQuerySchema = z.strictObject({
  kind: z.enum(["realtime", "archive"]).optional().describe("按执行类型过滤：realtime（日常单周期）或 archive（历史批量画像）"),
  status: z.enum(["running", "completed", "failed", "cancelled"]).optional().describe("按运行状态过滤；省略返回全部"),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe("返回数量，默认 20，范围 1–100"),
  cursor: z.string().min(1).max(2048).optional().describe("上一页返回的不透明 base64url 游标；过滤条件改变后重新开始"),
});

export const informationRunsResponse = z.strictObject({
  runs: z.array(informationRunResponseSchema),
  nextCursor: z.string().optional(),
});

export const informationRunDetailResponse = z.strictObject({
  run: informationRunResponseSchema,
  items: z.array(informationItemResponseSchema),
});

export const informationStatusResponse = z.strictObject({
  enabled: z.boolean(),
  batchWindowSeconds: z.number().int().nonnegative(),
  running: z.boolean(),
  pendingCount: z.number().int().nonnegative().describe("日常实时队列待处理条目数"),
  failedCount: z.number().int().nonnegative().describe("日常实时队列失败条目数"),
  archive: z.strictObject({
    running: z.boolean().describe("历史归档批量消化是否正在执行"),
    pendingCount: z.number().int().nonnegative(),
    processedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
  }),
  lastRunAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
});
