import { z } from "zod";
import { HABIT_DOMAIN_PATTERN, MAX_HABIT_TEXT_LENGTH } from "../../features/habits/types.js";
import { isWorkspaceText } from "../../shared/workspace-text.js";

export const habitDomainParamSchema = z
  .string()
  .regex(HABIT_DOMAIN_PATTERN, "domain must match [a-z][a-z0-9_-]{0,63}");

export const habitSourceSchema = z.enum(["consolidated", "manual"]);

export const habitRunStatusSchema = z.enum(["succeeded", "failed", "skipped", "cancelled"]);

export const habitItemSchema = z.strictObject({
  id: z.string().min(1).max(128).describe("习惯条目唯一标识（hab_...）"),
  domain: habitDomainParamSchema.describe("所属领域标识（如 sms、news）"),
  text: z.string().min(1).max(MAX_HABIT_TEXT_LENGTH).describe("AI 归纳或用户手写的行为习惯规范"),
  source: habitSourceSchema.describe("consolidated=模型归纳沉淀；manual=用户手动新增/修改"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const habitDomainOverviewResponse = z.strictObject({
  domain: habitDomainParamSchema.describe("目标领域 ID（如 sms、news）"),
  running: z.boolean().describe("当前是否有习惯归纳任务正在运行"),
  habits: z.array(habitItemSchema).describe("当前已持久化生效的行为习惯列表（最多 50 条，manual 与 consolidated 均自动注入对应领域模型上下文）"),
  unconsolidatedCount: z.number().int().nonnegative().describe("去重后尚未消化的活跃用户反馈目标数（热缓冲计数）"),
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
  .describe("必填有效 JSON 空对象 {}；触发立即归纳该领域未消化反馈");
