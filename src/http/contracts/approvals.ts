import { SESSION_ID_PATTERN } from "../../features/conversation/session-id.js";
import { z } from "zod";
import { ACTION_KINDS, type SettledActionStatus } from "../../features/actions/types.js";

export const approvalExecution = z.strictObject({
  status: z.enum(["running", "succeeded", "failed", "cancelled", "unknown"])
    .describe("真实执行结果：running=执行中；succeeded=执行成功；failed=失败；cancelled=取消；unknown=中断后无法确认，需核对结果"),
  startedAt: z.iso.datetime().describe("认领授权并准备执行的时间"),
  finishedAt: z.iso.datetime().nullable().describe("真实结束时间；仍执行中或崩溃无法确定时为 null"),
  result: z.string().nullable().describe("脱敏执行摘要；无结果时为 null，不包含凭据或原始诊断"),
}).describe("调用方回报的执行事实，与人的决定独立；approved 不代表执行成功");

/**
 * 审批（Approval）HTTP/SSE 契约：通用人工确认视图、历史摘要、终态投影、决定请求与分页。
 *
 * 边界：
 * - 审批记录只表达“人是否授权这一次操作”，不直接执行业务副作用；
 *   实际结果以调用方提交的执行回执与运行步骤为准。
 * - 预览内容在登记时固定，支持 file_diff（文件/设定前后对比）与 proposal（建议/操作要点列表）；
 *   完整预览不截断。
 * - revision 用于版本校验：创建时为 1，进入终态与每次执行回执时 +1；重复决定不推进版本。
 * - 待审批集合通过 SSE 直接推送；历史列表只返回已处理/失效审批的摘要，不含正文。
 * - HTTP 审批对象不带 instanceId：审批记录与 revision 跨进程持久，不随实例重启重置。
 */

/** 单项审批按 UTF-8 JSON 编码后的最大字节数（含完整预览正文）。 */
export const MAX_APPROVAL_BYTES = 1_500_000;
/** 同时存在的 pending 审批最大数量。 */
export const MAX_PENDING_APPROVALS = 32;
/** 所有 pending 审批按 UTF-8 JSON 编码后的累计最大字节数。 */
export const MAX_PENDING_APPROVAL_BYTES = 6_000_000;

const isoTime = z.iso.datetime().describe("ISO 8601 UTC 时间（服务端写入，固定 Z 后缀）");

const nullableSessionId = z
  .string()
  .min(1)
  .max(64)
  .nullable()
  .describe("会话标识；与当前审批无关时为 null，不推断当前上下文");

const nullableRunId = z
  .string()
  .min(1)
  .max(200)
  .nullable()
  .describe("发起审批的运行 ID；无法归属到具体运行时为 null");

const nullableRef = (label: string) =>
  z
    .string()
    .min(1)
    .max(200)
    .nullable()
    .describe(`${label}；未提供时为 null，不根据其他字段推断`);

export const approvalStatuses = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const;

export const terminalApprovalStatuses = [
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const;

export const approvalKinds = ACTION_KINDS;

// ---------------------------------------------------------------------------
// 通用审批预览（支持文件对比与建议/操作要点）
// ---------------------------------------------------------------------------
export const fileDiffApprovalPreview = z
  .strictObject({
    type: z.literal("file_diff").describe("文件/文本前后对比预览"),
    scope: z
      .enum(["workspace", "skill", "profile", "memory", "custom"])
      .describe("作用域：workspace=工作区；skill=技能；profile=个人设置；memory=记忆；custom=其他文本目标"),
    path: z
      .string()
      .min(1)
      .describe("相对逻辑路径；不返回服务端绝对路径，也不包含父目录穿越"),
    before: z
      .string()
      .describe("审批登记时的完整原文；新建目标为空串。内容固定，不随后续变化替换，不截断"),
    after: z
      .string()
      .describe("审批通过后计划写入的完整内容；不截断，不能只展示摘要或差异片段"),
    beforeExists: z
      .boolean()
      .describe("登记时目标是否已存在；false 表示新建，不能据此推断最终落盘结果"),
  })
  .describe("文件/设定变更的完整不可变前后对比。");

export const proposalApprovalItem = z.strictObject({
  label: z.string().min(1).describe("条目名称"),
  value: z.string().describe("条目内容"),
});

export const proposalApprovalPreview = z
  .strictObject({
    type: z.literal("proposal").describe("通用建议或敏感操作确认预览"),
    category: z.string().min(1).max(64).describe("来源分类标识，如 habit_learning / profile / general"),
    summary: z.string().min(1).describe("清晰说明待确认的建议或操作内容"),
    target: z.string().nullable().describe("影响的目标对象说明，无特定目标时为 null"),
    items: z.array(proposalApprovalItem).max(20).describe("结构化要点列表，最多 20 项"),
    confirmLabel: z.string().min(1).max(32).nullable().describe("建议的确认按钮文案；默认使用通用文案时为 null"),
    denyLabel: z.string().min(1).max(32).nullable().describe("建议的拒绝按钮文案；默认使用通用文案时为 null"),
  })
  .describe("通用建议/操作确认的不可变结构化预览。");

export const approvalPreview = z
  .discriminatedUnion("type", [fileDiffApprovalPreview, proposalApprovalPreview])
  .describe(
    "审批的完整、不可变预览（按 type 区分 file_diff 文件对比与 proposal 通用建议/操作确认）。" +
      "不读取当前目标替代历史预览，也不做截断。",
  );

export const approvalView = z
  .strictObject({
    id: z.string().min(1).describe("审批唯一 ID；同一审批在所有查询与事件中保持不变"),
    revision: z
      .number()
      .int()
      .min(1)
      .describe(
        "审批版本：创建时为 1，进入终态与每次执行回执时 +1。内容字段不可变；" +
          "客户端按 (id, revision) 判断是否已应用最新状态，重复决定不推进版本。",
      ),
    sessionId: nullableSessionId,
    runId: nullableRunId,
    toolCallId: nullableRef("发起审批的工具调用 ID"),
    subagentId: nullableRef("发起审批的子代理 ID"),
    kind: z
      .enum(approvalKinds)
      .describe("file_write=新建/覆盖文件；file_edit=编辑替换内容；proposal=建议/学习采纳确认；action=其他操作确认"),
    title: z
      .string()
      .min(1)
      .describe("人类可读的一句话摘要；不包含凭据或原始工具参数"),
    status: z
      .enum(approvalStatuses)
      .describe(
        "pending=等待人的决定；approved=人已授权（不代表执行成功）；denied=人拒绝执行；" +
          "expired=超过 expiresAt 自动失效；cancelled=运行取消、超时或服务停止导致撤销。" +
          "expired/cancelled 不是人的决定，decidedAt 保持 null。",
      ),
    preview: approvalPreview,
    execution: approvalExecution.nullable().describe("未观察到执行时为 null；批准本身不是执行成功。每次执行回执推进 revision"),
    createdAt: isoTime.describe("审批登记时间"),
    expiresAt: isoTime.describe("授权截止时间；登记时固定（默认 24 小时），不能由轮询或客户端延长"),
    resolvedAt: isoTime
      .nullable()
      .describe("进入终态的时间；pending 为 null。expired/cancelled 也以该时间作为结束时间"),
    decidedAt: isoTime
      .nullable()
      .describe("人工 approve/deny 的时间；expired、cancelled 或仍 pending 时为 null，不伪装成人的决定"),
  })
  .describe(
    "完整审批视图：包含不可变预览全文，供用户作决定或重新查看历史。GET /api/approvals/:id 返回此形状。" +
      "单项按 UTF-8 JSON 不超过 1.5MB；所有 pending 累计不超过 6MB 且最多 32 项；" +
      "超限时服务端拒绝登记，不截断预览。HTTP 对象不带 instanceId，revision 跨进程持久。",
  );

/** 历史列表摘要：保留身份、状态与时间，省略完整预览正文。 */
export const approvalSummary = approvalView
  .omit({ preview: true })
  .extend({ status: z.enum(terminalApprovalStatuses), resolvedAt: isoTime })
  .describe(
    "审批历史摘要：与完整视图相同，但省略 preview，不返回文件正文。列表只包含已处理/失效审批，" +
      "当前 pending 由 SSE 推送，不混入历史列表。",
  );

/**
 * 审批终态投影：用于 approval_updated 事件。保留身份关联、revision、终态与时间，
 * 去掉 title/kind/preview，避免重复推送大正文；客户端需要完整内容时按 id 查询详情。
 */
export const approvalResolution = approvalView
  .omit({ preview: true, title: true, kind: true })
  .extend({
    status: z
      .enum(terminalApprovalStatuses)
      .describe("终态：approved/denied/expired/cancelled；该事件不会携带 pending"),
  })
  .describe(
    "审批进入终态时的轻量投影：保留 id、revision、会话/运行/工具/子代理关联、" +
      "终态与 createdAt/expiresAt/resolvedAt/decidedAt；不包含 title、kind 和预览全文。" +
      "收到后按 (id, revision) 更新本地状态；未知 id 或需要完整内容时读取 GET /api/approvals/:id。",
  );

// ---------------------------------------------------------------------------
// 决定与查询
// ---------------------------------------------------------------------------
export const approvalDecisionRequest = z
  .strictObject({
    decision: z
      .enum(["approve", "deny"])
      .describe(
        "approve=授权执行预览中绑定的这一次操作，不代表执行成功；deny=不执行本次操作，由模型决定后续处理。",
      ),
  })
  .describe(
    "POST /api/approvals/:id/decision 的请求体。只接受 approve/deny；未声明字段返回 400。" +
      "只有 pending 可决定；未知 id 返回 404，已处于其他终态返回 409。" +
      "相同决定的重复提交幂等返回原审批，不再次执行，也不推进 revision。",
  );

/** 历史只含终态；十进制 limit 与过滤绑定游标在 HTTP 边界严格校验。 */
const historySessionId = z.string().min(1).max(64).regex(SESSION_ID_PATTERN);
export const approvalListQuery = z.strictObject({
  limit: z.preprocess((value) => typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value,
    z.number().int().min(1).max(100).default(20)).describe("每页数量，默认 20，范围 1–100；非十进制整数、空值或越界返回 400"),
  cursor: z.string().min(1).max(1024).optional().describe(
    "上一页 nextCursor，原样回传。不透明 base64url，绑定 resolvedAt/id 与 status/sessionId 过滤；结构非法、非规范编码或过滤不匹配返回 400，改变过滤后必须从第一页重新开始"),
  status: z.enum(terminalApprovalStatuses).optional().describe("只返回该终态，pending 非法；省略表示全部终态"),
  sessionId: historySessionId.optional().describe("只返回该来源会话的记录"),
}).describe("历史分页只包含终态；未声明、重复、非法参数或游标一律 400，按 resolvedAt 降序、同一时间按 id 降序");
export const approvalCursorPayloadSchema = z.strictObject({
  resolvedAt: z.iso.datetime(), id: z.string().min(1).max(200),
  status: z.enum(terminalApprovalStatuses).optional(), sessionId: historySessionId.optional(),
});
export type ApprovalFilter = { status?: SettledActionStatus; sessionId?: string };
export type ApprovalCursorPayloadDto = z.infer<typeof approvalCursorPayloadSchema>;
export const pendingApprovalsResponse = z.strictObject({ approvals: z.array(approvalView) })
  .describe("仅未过期 pending 的完整预览补充读取；主要同步来源仍是 SSE ready.pendingApprovals 与 approval_pending，查询不执行写入或恢复授权");

export const approvalPage = z
  .strictObject({
    approvals: z
      .array(approvalSummary)
      .describe("本页审批摘要，按最近处理时间倒序；同一时间按 id 降序"),
    hasMore: z.boolean().describe("是否还有下一页；true 时 nextCursor 非 null"),
    nextCursor: z
      .string()
      .nullable()
      .describe("下一页游标，不透明字符串；只能原样回传给 GET /api/approvals 的 cursor。没有更多时为 null"),
  })
  .describe(
    "审批历史分页结果。分页不冻结，但历史记录内容与预览在登记后不可变；" +
      "已处理/失效审批长期保留，不按时间或数量静默裁剪。",
  );

export type ApprovalPreviewDto = z.infer<typeof approvalPreview>;
export type ApprovalViewDto = z.infer<typeof approvalView>;
export type ApprovalSummaryDto = z.infer<typeof approvalSummary>;
export type ApprovalResolutionDto = z.infer<typeof approvalResolution>;
export type ApprovalDecisionRequestDto = z.infer<typeof approvalDecisionRequest>;
export type ApprovalListQueryDto = z.infer<typeof approvalListQuery>;
export type ApprovalPageDto = z.infer<typeof approvalPage>;
