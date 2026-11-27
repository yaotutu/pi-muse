import { z } from "zod";
import { HABIT_SUBAGENT_PATTERN, MAX_HABIT_TEXT_LENGTH } from "../../features/habits/types.js";
import { isWorkspaceText } from "../../shared/workspace-text.js";

export const habitSubagentParamSchema = z
  .string()
  .regex(HABIT_SUBAGENT_PATTERN, "subagentId must match [a-z][a-z0-9_-]{0,63}");

export const habitSourceSchema = z.enum(["consolidated", "manual"]);

export const habitRunStatusSchema = z.enum(["succeeded", "failed", "skipped", "cancelled"]);

export const habitItemSchema = z.strictObject({
  id: z.string().min(1).max(128).describe("习惯条目唯一标识（hab_...）"),
  subagentId: habitSubagentParamSchema.describe("所属专职 Subagent 标识（如 sms）"),
  text: z.string().min(1).max(MAX_HABIT_TEXT_LENGTH).describe("AI 归纳或用户手写的行为习惯规范"),
  source: habitSourceSchema.describe("consolidated=模型归纳沉淀；manual=用户手动新增/修改"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const habitPendingSignalSchema = z.strictObject({
  targetId: z.string().min(1).max(200).describe("反馈关联的目标 ID（如通知 ID 或文章 ID）"),
  kind: z.string().min(1).max(64).describe("反馈信号来源类型（如 sms_notification）"),
  summary: z.string().describe("被反馈对象的摘要文本"),
  reaction: z.enum(["like", "dislike"]).nullable(),
  saved: z.boolean(),
  comments: z.array(z.string()),
  commentsTruncated: z.boolean(),
  updatedAt: z.string().datetime(),
});

export const habitSubagentSummarySchema = z.strictObject({
  subagentId: habitSubagentParamSchema.describe("目标专职 Subagent ID（如 sms）"),
  name: z.string().min(1).describe("Subagent 展示名称"),
  summary: z.string().min(1).describe("Subagent 职责说明"),
  running: z.boolean().describe("当前是否有习惯归纳任务正在运行"),
  habitsCount: z.number().int().nonnegative().describe("已生效习惯条数"),
  unconsolidatedCount: z.number().int().nonnegative().describe("去重后尚未消化的活跃用户反馈目标数（热缓冲计数）"),
  autoThreshold: z.number().int().positive().describe("达到该未消化反馈数时自动触发后台归纳的阈值"),
  intervalMs: z.number().int().positive().describe("兜底周期自动归纳间隔（毫秒，默认 2 小时）"),
  lastRunAt: z.string().datetime().nullable().describe("最近一次归纳完成/结束时间"),
  lastRunStatus: habitRunStatusSchema.nullable().describe("最近一次归纳状态：succeeded / failed / skipped / cancelled"),
  lastRunError: z.string().nullable().describe("最近一次失败/取消原因；成功或未失败时为 null"),
});

export const habitSubagentsListResponse = z.strictObject({
  subagents: z.array(habitSubagentSummarySchema).describe("服务端全部已注册的行为习惯 Subagent 摘要列表"),
});

export const habitSubagentOverviewResponse = z.strictObject({
  subagentId: habitSubagentParamSchema.describe("目标专职 Subagent ID（如 sms）"),
  name: z.string().min(1).describe("Subagent 展示名称"),
  summary: z.string().min(1).describe("Subagent 职责说明"),
  running: z.boolean().describe("当前是否有习惯归纳任务正在运行"),
  habits: z.array(habitItemSchema).describe("当前已持久化生效的行为习惯列表（最多 50 条，manual 与 consolidated 均自动注入对应 Subagent 上下文）"),
  unconsolidatedCount: z.number().int().nonnegative().describe("去重后尚未消化的活跃用户反馈目标数（热缓冲计数）"),
  pendingSignals: z.array(habitPendingSignalSchema).describe("去重后的近期活跃待归纳反馈样本摘要（按最新时间倒序，最多 20 条，归纳提交后自动清空）"),
  autoThreshold: z.number().int().positive().describe("达到该未消化反馈数时自动触发后台归纳的阈值"),
  intervalMs: z.number().int().positive().describe("兜底周期自动归纳间隔（毫秒，默认 2 小时）"),
  cursorSeq: z.number().int().nonnegative().describe("已原子提交消化的最大信号 seq 游标"),
  lastRunAt: z.string().datetime().nullable().describe("最近一次归纳完成/结束时间"),
  lastRunStatus: habitRunStatusSchema.nullable().describe("最近一次归纳状态：succeeded / failed / skipped / cancelled"),
  lastRunProcessed: z.number().int().nonnegative().describe("最近一次成功归纳消化的去重反馈目标数"),
  lastRunError: z.string().nullable().describe("最近一次失败/取消原因；成功或未失败时为 null"),
});

export const createHabitRequestSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1, "Habit text cannot be empty")
    .max(MAX_HABIT_TEXT_LENGTH, `Habit text must be at most ${MAX_HABIT_TEXT_LENGTH} characters`)
    .refine(isWorkspaceText, "Invalid habit text")
    .describe("习惯正文（1–300 字符）"),
});

export const updateHabitRequestSchema = createHabitRequestSchema;

export const habitItemResponse = z.strictObject({
  habit: habitItemSchema,
});

export const deleteHabitResponse = z.strictObject({
  deleted: z.literal(true),
  id: z.string().min(1).max(128),
});

export const consolidateHabitsRequestSchema = z
  .strictObject({})
  .describe("必填有效 JSON 空对象 {}；触发立即归纳该 Subagent 未消化反馈");
