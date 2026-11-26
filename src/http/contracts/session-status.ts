import { SESSION_ID_PATTERN } from "../../features/conversation/session-id.js";
import { z } from "zod";
import {
  MAX_STATUS_STEPS,
  MAX_STATUS_SUBAGENTS,
  MAX_STATUS_TOOLS,
  MAX_STEP_TEXT_LENGTH,
  runStepKinds,
  runStepStatuses,
} from "../../features/workspace/session-status.js";

/**
 * 运行状态（Run Status & Steps）HTTP/SSE 契约：单个 run 的实时与持久化步骤时间线。
 *
 * 边界：
 * - 这是服务端对真实执行事件的客观、脱敏投影，由服务端自动记录并随会话历史持久化。
 * - 同一 (sessionId, runId) 的每次变化推进 revision；客户端按 revision 合并。
 * - 工具名在受控/隐藏策略下 output null，由 title/detail/label 承担脱敏展示文案。
 */

/** 运行标题最大字符数。 */
export const MAX_STATUS_TITLE_LENGTH = 500;
/** 运行/子代理展示文案最大字符数。 */
export const MAX_STATUS_LABEL_LENGTH = 500;

export const agentRunStatuses = ["running", "succeeded", "failed", "cancelled"] as const;
export const agentPhases = [
  "preparing",
  "waiting_model",
  "responding",
  "executing_tool",
  "waiting_subagents",
  "waiting_approval",
  "finalizing",
] as const;
export const agentToolStatuses = ["running", "waiting_approval"] as const;
export const subsessionStatuses = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

/**
 * 子代理没有“等待子代理”阶段，避免出现自我等待；其余阶段与父运行一致。
 */
export const subagentPhases = [
  "preparing",
  "waiting_model",
  "responding",
  "executing_tool",
  "waiting_approval",
  "finalizing",
] as const satisfies readonly Exclude<(typeof agentPhases)[number], "waiting_subagents">[];

type AssertNever<T extends never> = T;
type _SubagentPhasesCovered = AssertNever<
  Exclude<
    Exclude<(typeof agentPhases)[number], "waiting_subagents">,
    (typeof subagentPhases)[number]
  >
>;

const isoTime = z.iso.datetime().describe("ISO 8601 UTC 时间（服务端写入，固定 Z 后缀）");

const sessionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(SESSION_ID_PATTERN)
  .describe("公开会话 id：main 或规范小写 UUID；不接受历史命名或任务前缀");

const runIdSchema = z.string().min(1).max(200).describe("运行标识；同一会话内唯一，最长 200");

export const runStep = z
  .strictObject({
    id: z.string().min(1).max(200).describe("步骤在运行内的唯一标识"),
    parentId: z.string().min(1).max(200).nullable().describe("父步骤或子代理 ID；顶层步骤为 null"),
    kind: z.enum(runStepKinds).describe("步骤类型：tool=工具调用；subagent=子代理委派；approval=人工审批；file_commit=文件落盘校验"),
    title: z.string().min(1).max(MAX_STEP_TEXT_LENGTH).describe("人类可读步骤标题"),
    detail: z.string().max(MAX_STEP_TEXT_LENGTH).nullable().describe("脱敏后的关键摘要（如搜索词、网页域名/路径、文件名、角色），不含正文/SQL/凭据"),
    status: z.enum(runStepStatuses).describe("步骤状态：queued/running/waiting_approval/succeeded/failed/denied/expired/cancelled"),
    result: z.string().max(MAX_STEP_TEXT_LENGTH).nullable().describe("简洁结果说明；进行中或无说明时为 null"),
    toolName: z.string().min(1).nullable().describe("公开工具名；隐藏策略或非工具步骤为 null"),
    approvalId: z.string().min(1).max(200).nullable().describe("关联的审批 ID（kind=approval 时非 null）"),
    startedAt: isoTime.describe("步骤开始时间"),
    endedAt: isoTime.nullable().describe("步骤结束时间；进行中为 null"),
  })
  .describe("运行中的一步客观执行记录，不包含模型内部思维、凭据或原始大文本载荷。");

// ---------------------------------------------------------------------------
// 运行状态投影
// ---------------------------------------------------------------------------
export const agentToolState = z
  .strictObject({
    toolCallId: z.string().min(1).describe("工具调用 ID；与聊天历史中的 toolCallId 对应"),
    name: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "工具名；受控或隐藏工具为 null，表示服务端不暴露真实工具名。展示必须使用 label，" +
          "不要把 null 当作错误，也不要自行推断工具。",
      ),
    label: z
      .string()
      .max(MAX_STATUS_LABEL_LENGTH)
      .describe("可直接展示的工具状态文案；不包含原始参数、凭据或未脱敏内容"),
    status: z
      .enum(agentToolStatuses)
      .describe("running=正在执行；waiting_approval=工具已挂起，等待人工审批"),
    subagentId: z
      .string()
      .min(1)
      .nullable()
      .describe("发起该工具调用的子代理 ID；父运行直接发起的工具为 null"),
  })
  .describe("运行中的一次工具调用。工具结束后从数组移除，完整轨迹见 steps。");

export const subagentState = z
  .strictObject({
    id: z.string().min(1).describe("子代理运行 ID，运行内稳定"),
    role: z.string().min(1).describe("子代理角色名；由服务端定义，不是模型自由文本"),
    status: z
      .enum(subsessionStatuses)
      .describe("queued=等待并发名额；running=执行中；其余为终态，失败/取消如实保留"),
    phase: z
      .enum(subagentPhases)
      .nullable()
      .describe(
        "子代理当前阶段；与父运行阶段同名，但不含 waiting_subagents。终态或尚未开始时为 null。",
      ),
    label: z
      .string()
      .max(MAX_STATUS_LABEL_LENGTH)
      .describe("可直接展示的子代理状态文案；不包含模型思维或原始工具载荷"),
    startedAt: isoTime.nullable().describe("开始执行时间；仍在排队或从未开始时为 null"),
    updatedAt: isoTime.describe("该子代理状态最近一次变化时间"),
    endedAt: isoTime.nullable().describe("进入终态的时间；未结束时为 null"),
  })
  .describe("运行内的子代理状态。");

export const sessionStatus = z
  .strictObject({
    sessionId: sessionIdSchema.describe("所属会话"),
    runId: runIdSchema,
    revision: z
      .number()
      .int()
      .min(1)
      .describe(
        "运行展示版本；创建时为 1，每次状态变化 +1。客户端只应用更高 revision；" +
          "instanceId 变化后应清空运行版本缓存，以新的 ready 为准。",
      ),
    source: z
      .enum(["chat", "job"])
      .describe("来源：chat=用户聊天触发的运行；job=定时任务触发的运行"),
    jobId: z
      .string()
      .min(1)
      .nullable()
      .describe("source=job 时对应的定时任务 ID；source=chat 时为 null"),
    title: z
      .string()
      .max(MAX_STATUS_TITLE_LENGTH)
      .describe("运行标题"),
    status: z
      .enum(agentRunStatuses)
      .describe("running=执行中；succeeded=正常完成；failed=失败；cancelled=用户或系统取消"),
    phase: z
      .enum(agentPhases)
      .nullable()
      .describe(
        "running 时的当前阶段：preparing/waiting_model/responding/executing_tool/" +
          "waiting_subagents/waiting_approval/finalizing；终态为 null。",
      ),
    label: z
      .string()
      .max(MAX_STATUS_LABEL_LENGTH)
      .describe("可直接展示的整体状态文案；不包含模型思维、凭据或原始工具参数"),
    tools: z
      .array(agentToolState)
      .max(MAX_STATUS_TOOLS)
      .describe("当前进行中的工具调用；最多 64 个，结束即移除"),
    subagents: z
      .array(subagentState)
      .max(MAX_STATUS_SUBAGENTS)
      .describe("当前运行的子代理状态；最多 64 个"),
    pendingApprovalIds: z
      .array(z.string().min(1))
      .describe(
        "该运行当前等待的审批 ID 引用；审批完整内容通过 approval_pending 事件单独推送。终态时清空。",
      ),
    steps: z
      .array(runStep)
      .max(MAX_STATUS_STEPS)
      .describe("本轮自动记录的执行步骤时间线（含工具、子代理、审批与文件提交），随会话持久化，普通无工具问答为空数组。"),
    startedAt: isoTime.describe("运行开始时间"),
    updatedAt: isoTime.describe("运行状态最近一次变化时间；只用于展示，不作为事件排序依据"),
    endedAt: isoTime.nullable().describe("进入终态的时间；仍在 running 时为 null"),
  })
  .describe(
    "单个运行的完整状态快照与步骤时间线，随会话历史持久化；同一 (sessionId, runId) 按 revision 合并。",
  );

// ---------------------------------------------------------------------------
// 查询与 HTTP 响应
// ---------------------------------------------------------------------------
export const sessionStatusQuery = z
  .strictObject({
    sessionId: sessionIdSchema.describe("要查询的运行所属会话"),
    runId: runIdSchema.describe("要查询的运行 ID；必填"),
  })
  .describe("GET /api/runs/status 查询参数；两个字段都必填，不接受未声明参数。");

export const sessionStatusResponse = z
  .strictObject({
    instanceId: z
      .uuid()
      .describe(
        "产生该状态的服务进程实例 UUID。变化表示服务重启或切换到新实例；" +
          "运行 revision 只在该实例内存内有效，instanceId 变化后应清空运行版本缓存。",
      ),
    status: sessionStatus,
  })
  .describe(
    "GET /api/runs/status 的响应：指定运行的当前状态（含步骤时间线），或运行结束后持久化的最终状态。" +
      "运行不存在或已被清理时返回 404。",
  );

const runLimitSchema = z
  .preprocess(
    (value) => (typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value),
    z.number().int().min(1).max(100).default(20),
  )
  .describe("每页数量，默认 20，范围 1–100；非法值返回 400");

export const runListQuery = z
  .strictObject({
    sessionId: sessionIdSchema.describe("所属会话 ID；必填"),
    limit: runLimitSchema,
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe("上一页返回的 nextCursor；绑定 sessionId，跨会话或格式非法返回 400"),
  })
  .describe("GET /api/runs 分页查询指定会话的有效执行记录（普通纯文字问答不记入）。");

export const runCursorPayloadSchema = z.strictObject({
  startedAt: isoTime,
  runId: runIdSchema,
  sessionId: sessionIdSchema,
});

export const runListResponse = z
  .strictObject({
    instanceId: z.uuid().describe("产生该响应的服务实例 UUID"),
    runs: z.array(sessionStatus).describe("按 startedAt 倒序、同时间按 runId 倒序排列的有效运行记录（包含进行中与含实际动作/子代理/审批/定时任务/失败中断的已完成运行；普通纯文字问答不返回）"),
    hasMore: z.boolean().describe("是否还有下一页"),
    nextCursor: z.string().nullable().describe("下一页不透明游标，无更多时为 null"),
  })
  .describe("GET /api/runs 的响应：指定会话的有效运行记录分页列表。");

export type RunStepDto = z.infer<typeof runStep>;
export type AgentToolStateDto = z.infer<typeof agentToolState>;
export type SubagentStateDto = z.infer<typeof subagentState>;
export type SessionStatusDto = z.infer<typeof sessionStatus>;
export type AgentStatusQueryDto = z.infer<typeof sessionStatusQuery>;
export type AgentStatusResponseDto = z.infer<typeof sessionStatusResponse>;
export type RunListQueryDto = z.infer<typeof runListQuery>;
export type RunListResponseDto = z.infer<typeof runListResponse>;
export type RunCursorPayloadDto = z.infer<typeof runCursorPayloadSchema>;
