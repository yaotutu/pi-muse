import { z } from "zod";

const agentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const agentRequestSchema = z.strictObject({
  sourceAgentId: agentId.describe("发起智能体；包括新闻与短信，不做智能体白名单检查"),
  targetAgentId: agentId.describe("处理智能体；必须已存在，不隐式创建"),
  message: z.string().trim().min(1).max(20000),
  discussionId: z.uuid().optional().describe("首次省略；后续使用同一目标和返回的 discussionId 延续独立上下文"),
  context: z.string().max(20000).optional().describe("显式提供的必要背景；不自动复制来源智能体聊天历史"),
});
export const agentRequestResponse = z.strictObject({
  requestId: z.uuid(), discussionId: z.uuid(), sourceAgentId: agentId, sourceSessionId: z.string().describe("实际调用会话；嵌套请求时是来源讨论的 pi session，不冒充其主聊天"), sourceDiscussionId: z.uuid().optional(), targetAgentId: agentId,
  status: z.enum(["completed", "failed", "cancelled"]).describe("本次模型轮的执行结果；completed 不代表整个事项完成，text 也可以是澄清问题"),
  text: z.string(),
});
export const discussionHistoryResponse = z.strictObject({
  agentId, discussionId: z.uuid(), messages: z.array(z.strictObject({
    id: z.string(), role: z.enum(["user", "assistant", "tool"]), content: z.string(),
    toolCallId: z.string().optional(),
    toolCalls: z.array(z.strictObject({ id: z.string(), type: z.literal("function"), function: z.strictObject({ name: z.string(), arguments: z.string() }) })).optional(),
    isError: z.boolean().optional(),
  })),
});
export const agentCommunicationEndpoints = [
  { operationId: "requestAgent", method: "post" as const, path: "/api/agent-communication/requests", summary: "请求另一个智能体处理并返回回复", request: agentRequestSchema, response: agentRequestResponse,
    hint: "同步执行目标智能体独立讨论中的一轮 pi 模型，目标自己的规则、技能、工作区和已有信息可用，不复制双方主聊天历史。回复沿原调用返回，不写入主聊天、不走普通通知队列、不启动来源模型；绑定只控制后台主动通知。返回 discussionId 可追问或澄清。原始正文与工具事实仅由目标 sessions/<agentId>/discussions/ 中的 pi JSONL 保存。相同讨论在途请求返回 409 BUSY，不建立可靠队列、不自动重试；断开请求、超时、来源或目标 reset/delete、服务关闭均取消关联执行。来源 reset 不删除另一智能体已有讨论；目标 reset/delete 清除其讨论。失败或取消前已完成的副作用不回滚。已有鉴权、凭据保护与模型文件修改审批不变。文件审批归调用来源的智能体/运行，workspaceAgentId 与预览 ownerAgentId 是实际执行智能体；HTTP 直接请求的审批 runId 为返回的 requestId。通知卡片的显式继续处理通过群发送契约的 notification 引用复用本执行器；仍不提供系统推送。" },
  { operationId: "getAgentDiscussion", method: "get" as const, path: "/api/agent-communication/discussions/:targetAgentId/:discussionId", summary: "读取智能体独立讨论历史", response: discussionHistoryResponse,
    hint: "只读投影 pi 的权威历史，工具载荷按现有展示策略脱敏；不存在返回 404，不创建智能体或讨论。处理中的讨论返回 409，避免读取半轮。请求回复与主动通知是不同通道，不将查询内容重新插入 main。" },
].map((endpoint) => ({ tag: "智能体通信", auth: true, ...endpoint }));
