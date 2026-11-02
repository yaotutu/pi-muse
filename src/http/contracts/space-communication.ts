import { z } from "zod";

const spaceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const spaceRequestSchema = z.strictObject({
  sourceSpaceId: spaceId.describe("发起空间；可以是普通空间或功能空间，不做空间白名单检查"),
  targetSpaceId: spaceId.describe("处理空间；必须已存在，不隐式创建"),
  message: z.string().trim().min(1).max(20000),
  discussionId: z.uuid().optional().describe("首次省略；后续使用同一目标和返回的 discussionId 延续独立上下文"),
  context: z.string().max(20000).optional().describe("显式提供的必要背景；不自动复制来源空间聊天历史"),
});
export const spaceRequestResponse = z.strictObject({
  requestId: z.uuid(), discussionId: z.uuid(), sourceSpaceId: spaceId, sourceSessionId: z.string().describe("实际调用会话；嵌套请求时是来源讨论的 pi session，不冒充其主聊天"), sourceDiscussionId: z.uuid().optional(), targetSpaceId: spaceId,
  status: z.enum(["completed", "failed", "cancelled"]).describe("本次模型轮的执行结果；completed 不代表整个事项完成，text 也可以是澄清问题"),
  text: z.string(),
});
export const communicationSpacesResponse = z.strictObject({ spaces: z.array(z.strictObject({ id: spaceId, name: z.string(), kind: z.enum(["feature", "workspace"]) })) });
export const discussionHistoryResponse = z.strictObject({
  spaceId, discussionId: z.uuid(), messages: z.array(z.strictObject({
    id: z.string(), role: z.enum(["user", "assistant", "tool"]), content: z.string(),
    toolCallId: z.string().optional(),
    toolCalls: z.array(z.strictObject({ id: z.string(), type: z.literal("function"), function: z.strictObject({ name: z.string(), arguments: z.string() }) })).optional(),
    isError: z.boolean().optional(),
  })),
});
export const spaceCommunicationEndpoints = [
  { operationId: "listCommunicationSpaces", method: "get" as const, path: "/api/space-communication/spaces", summary: "列出可通信空间（含功能空间）", response: communicationSpacesResponse,
    hint: "内部空间默认互信，无调用白名单、绑定授权或额外逐次确认。普通空间列表仍只用于工作空间切换；此入口同时列出 news-internal、sms-internal。" },
  { operationId: "requestSpace", method: "post" as const, path: "/api/space-communication/requests", summary: "请求另一个空间处理并返回回复", request: spaceRequestSchema, response: spaceRequestResponse,
    hint: "同步执行目标空间独立讨论中的一轮 pi 模型，目标自己的规则、技能、工作区和已有信息可用，不复制双方主聊天历史。回复沿原调用返回，不写入主聊天、不走普通通知队列、不启动来源模型；绑定只控制后台主动通知。返回 discussionId 可追问或澄清。原始正文与工具事实仅由目标 sessions/<spaceId>/discussions/ 中的 pi JSONL 保存。相同讨论在途请求返回 409 BUSY，不建立可靠队列、不自动重试；断开请求、超时、来源或目标 reset/delete、服务关闭均取消关联执行。来源 reset 不删除另一空间已有讨论；目标 reset/delete 清除其讨论。失败或取消前已完成的副作用不回滚。已有鉴权、凭据保护与模型文件修改审批不变。文件审批归调用来源的空间/运行，workspaceSpaceId 与预览 ownerSpaceId 是实际执行空间；HTTP 直接请求的审批 runId 为返回的 requestId。第一批未提供卡片讨论 UI 或系统推送。" },
  { operationId: "getSpaceDiscussion", method: "get" as const, path: "/api/space-communication/discussions/:targetSpaceId/:discussionId", summary: "读取空间独立讨论历史", response: discussionHistoryResponse,
    hint: "只读投影 pi 的权威历史，工具载荷按现有展示策略脱敏；不存在返回 404，不创建空间或讨论。处理中的讨论返回 409，避免读取半轮。请求回复与主动通知是不同通道，不将查询内容重新插入 main。" },
].map((endpoint) => ({ tag: "空间通信", auth: true, ...endpoint }));
