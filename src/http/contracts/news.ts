import { z } from "zod";
import { isWorkspaceText } from "../../shared/workspace-text.js";
import { newsSourceFailureCategories } from "../../features/news/errors.js";
import { habitItemSchema } from "./habits.js";
import { workspaceIncludeDiagnosticSchema } from "./workspace-includes.js";

const publicHttpUrlSchema = z.string().url().max(2048).regex(/^https?:\/\//i).refine((value) => {
  const url = new URL(value);
  const credentialKeys = new Set(["username", "pass" + "word"] as const);
  return ![...credentialKeys].some((key) => url[key as keyof URL] !== "");
}, "URL must not contain credentials").describe("无凭据的公网 HTTP(S) URL");

const newsIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

export const newsSourceFailureSchema = z.strictObject({
  category: z.enum(newsSourceFailureCategories).describe("NETWORK=DNS/网络错误；SSRF_BLOCKED=私网/本机目标阻断；TIMEOUT=超时；HTTP_ERROR=最终 HTTP 非 2xx；PARSE_INVALID=无效 RSS2/解析限制/过半条目无效；UNKNOWN=其他受控失败"),
  httpStatus: z.number().int().min(100).max(599).optional().describe("仅 HTTP_ERROR 携带已知 HTTP 状态码；不含上游响应体、外部内容、重定向地址或内部堆栈"),
});

export const newsCreateSourceErrorSchema = z.strictObject({
  error: z.string().describe("受控错误文案，不含外部响应体或内部堆栈"),
  code: z.literal("INVALID_INPUT"),
  failure: newsSourceFailureSchema.optional().describe("源抓取/解析失败时必有，与源 lastErrorDetails 使用同一分类；请求字段/JSON 校验失败时省略"),
});

export const newsStatusResponseSchema = z.strictObject({
  refreshing: z.boolean().describe("一次源抓取是否正在运行"),
  processing: z.boolean().describe("受限信息模型轮是否正在处理"),
  pendingCount: z.number().int().nonnegative().describe("已接纳但尚未成功筛选的文章数"),
  failedCount: z.number().int().nonnegative().describe("模型筛选失败且仍待处理的文章数"),
  lastRefreshedAt: z.string().datetime().nullable().describe("最近一次源抓取完成时间；从未抓取为 null"),
  lastError: z.string().nullable().describe("最近一次源抓取或源解析的受控错误；无失败为 null"),
});

export const newsSourceResponseSchema = z.strictObject({
  id: newsIdSchema.describe("服务端生成的稳定源 ID"),
  title: z.string().min(1).max(500).describe("用户可见源标题"),
  url: publicHttpUrlSchema.describe("RSS2 feed 地址"),
  createdAt: z.string().datetime(),
  lastFetchedAt: z.string().datetime().nullable().describe("该源最近一次抓取完成时间；尚未抓取为 null"),
  lastError: z.string().nullable().describe("该源最近一次受控失败文案；无失败为 null"),
  lastErrorDetails: newsSourceFailureSchema.nullable().optional().describe("该源最近一次失败分类，与添加源 400 的 failure 相同；成功后为 null；旧存储尚无分类时省略。不推断旧错误，不迁移数据"),
});

export const newsSourceListResponseSchema = z.strictObject({
  sources: z.array(newsSourceResponseSchema),
});

export const newsCreateSourceRequestSchema = z.strictObject({
  url: publicHttpUrlSchema,
  title: z.string().trim().min(1).max(500).optional().describe("可选标题；缺省使用 feed channel title"),
});

export const newsCreateSourceResponseSchema = z.strictObject({
  source: newsSourceResponseSchema,
  skipped: z.number().int().nonnegative().describe("本次验证中因缺标题或稳定 ID 跳过的条目数；添加源只验证，不接纳文章"),
});

export const newsDeleteSourceResponseSchema = z.strictObject({
  deleted: z.literal(true),
  sourceId: newsIdSchema,
});

const newsCommentSchema = z.strictObject({
  id: z.string().describe("服务端生成的评论 ID"),
  text: z.string().min(1).max(4000).describe("已 trim 的评论正文"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const newsFeedbackSchema = z.strictObject({
  reaction: z.enum(["like", "dislike"]).nullable().describe("like 与 dislike 互斥；null 表示撤销"),
  saved: z.boolean().describe("收藏状态，独立于 like/dislike"),
  comments: z.array(newsCommentSchema).describe("该文章的评论，按创建时间稳定排序"),
});

export const newsArticleResponseSchema = z.strictObject({
  id: newsIdSchema.describe("服务端稳定的文章 ID"),
  sourceId: newsIdSchema,
  sourceTitle: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  url: publicHttpUrlSchema.nullable().describe("原文链接；源条目没有有效无凭据 HTTP(S) URL 时为 null"),
  content: z.string().min(1).max(20000).describe("RSS 摘要/正文清理后的安全 UTF-8 文本；有 ID/标题但正文为空的条目仍保留，以标题作为最小正文"),
  publishedAt: z.string().datetime().describe("RSS 声明的发布时间；无有效值使用接纳时间，用于排序"),
  acceptedAt: z.string().datetime().describe("服务端首次接纳时间"),
  recommendation: z.strictObject({
    reason: z.string().min(1).max(1000),
  }).nullable().describe("仅结构化筛选成功选中的文章有推荐理由"),
  feedback: newsFeedbackSchema,
});

export const newsArticlesQuerySchema = z.strictObject({
  view: z.enum(["recommended", "all"]).default("all").describe("all=全部时间线；recommended=仅成功模型筛选选中的文章"),
  savedOnly: z.enum(["true", "false"]).default("false").transform((value) => value === "true").describe("true 只返回已收藏文章；false 或省略返回未限定收藏的列表；不改变基础排序"),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe("返回数量，默认 20，范围 1–100"),
  cursor: z.string().min(1).max(2048).optional().describe("上一页返回的不透明 base64url 游标；过滤条件改变后重新开始"),
});

export const newsArticleListResponseSchema = z.strictObject({
  articles: z.array(newsArticleResponseSchema),
  nextCursor: z.string().nullable().describe("还有下一页时为不透明游标，否则为 null"),
});

export const newsArticleDetailResponseSchema = z.strictObject({
  article: newsArticleResponseSchema,
});

export const newsReactionRequestSchema = z.strictObject({
  reaction: z.enum(["like", "dislike"]).nullable().describe("null 撤销当前反应"),
});

export const newsSavedRequestSchema = z.strictObject({
  saved: z.boolean(),
});

export const newsCommentCreateRequestSchema = z.strictObject({
  text: z.string().trim().min(1, "Comment must not be blank").max(4000),
});

export const newsFeedbackResponseSchema = z.strictObject({
  feedback: newsFeedbackSchema,
});

export const newsRefreshRequestSchema = z.strictObject({}).describe("必填有效 JSON 空对象 {}；非法 JSON、空请求体或额外字段返回 400，不执行抓取/failed 重置");
export const newsRefreshResponseSchema = z.strictObject({
  added: z.number().int().nonnegative().describe("本次源抓取新接纳的文章数；不等待模型分析完成"),
  skipped: z.number().int().nonnegative().describe("成功解析的源中缺标题或稳定 ID 而跳过的条目总数；解析失败的源不计入"),
  resetDeferred: z.boolean().describe("true=新闻模型轮运行，本次未重置 failed 条目；不会自动补重试。false=未因模型轮运行跳过重置，不表示模型分析已完成"),
});

export const newsPreferencesResponseSchema = z.strictObject({
  instructions: z.string().max(20000).describe("用户明确保存的新闻 Subagent 筛选指令（subagents/news/INSTRUCTIONS.md）"),
  includes: z.array(workspaceIncludeDiagnosticSchema).describe("INSTRUCTIONS.md 顶部 YAML frontmatter `include:` 引用展开诊断"),
  habits: z.array(habitItemSchema).describe("通用习惯引擎从文章反馈自动归纳（或用户手动维护）的行为习惯列表"),
  unconsolidatedFeedbackCount: z.number().int().nonnegative().describe("去重后尚未归纳成长期习惯的文章反馈热缓冲条数"),
});

export const newsPreferencesUpdateRequestSchema = z.strictObject({
  instructions: z.string().max(20000).refine(isWorkspaceText).describe("空串等于清空；最后成功保存生效"),
});

export type NewsArticleDto = z.infer<typeof newsArticleResponseSchema>;
export type NewsArticleListDto = z.infer<typeof newsArticleListResponseSchema>;
