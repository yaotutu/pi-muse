import { z } from "zod";
import { discussionHistoryResponse } from "./agent-communication.js";

const agentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const notificationReferenceSchema = z.strictObject({ targetAgentId: agentId, sessionId: z.string().min(1).max(128), messageId: z.string().min(1).max(128) });
export const groupTurnSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), rootId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sourceAgentId: agentId.nullable().describe("null 表示用户；否则是显式请求另一个成员的智能体"),
  targetAgentId: agentId, discussionId: z.uuid(), createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  notification: notificationReferenceSchema.optional().describe("通知的实际承接位置；关联独立来源讨论，嵌套请求继承，不含第二份正文"),
});
export const groupNotificationSchema = z.strictObject({
  id: z.string().min(1).describe("PI 通知 marker 中的稳定 notificationId"), featureId: z.enum(["news", "sms"]),
  targetAgentId: agentId.describe("该条通知实际落盘的承接智能体，不是功能的当前绑定"),
  sessionId: z.string().min(1), messageId: z.string().min(1), createdAt: z.iso.datetime(), content: z.string(),
});
export const groupSnapshotSchema = z.strictObject({ id: z.literal("main"), defaultAgentId: z.literal("local-main"), running: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  turns: z.array(groupTurnSchema.extend({ messages: discussionHistoryResponse.shape.messages })),
  notifications: z.array(groupNotificationSchema).describe("当前承接会话中来源已验证的功能通知；只读展示；仅显式继续处理时将服务端核实的来源作为引用背景传给来源 Agent") });
export const groupSendSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe("客户端本次发送的稳定 ID；已接纳的 ID 不可重发，先回读核对"),
  content: z.string().trim().min(1).max(20000), targetAgentId: agentId.optional().describe("仅显式 @ 选中成员时发送；省略只交给 local-main，不广播、不按内容猜路由。每条消息至多一个目标。"),
  notification: notificationReferenceSchema.optional().describe("继续处理已验证通知；与 targetAgentId 互斥。服务端验证当前会话的通知 marker，决定真实来源 Agent；改绑不改变旧通知，失效不回退 main。")
}).refine((input) => !(input.notification && input.targetAgentId), { message: "notification and targetAgentId are mutually exclusive" });
export const groupStreamEvents = {
  turn: z.strictObject({ type: z.literal("turn"), turn: groupTurnSchema }),
  delta: z.strictObject({ type: z.literal("delta"), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), text: z.string() }),
  settled: z.strictObject({ type: z.literal("settled") }),
  error: z.strictObject({ type: z.literal("error"), code: z.string(), message: z.string() }),
};
export const groupEndpoints = [
  { operationId: "getGroupChat", method: "get" as const, path: "/api/group", summary: "读取默认群聊", response: groupSnapshotSchema,
    hint: "固定一个 main 群组，成员目录使用 GET /api/agents。群组不是 Agent：绝不拼接普通私聊或将群时间线注入模型。每个成员的群聊讨论与私聊上下文独立；只有发给它的消息及它显式 agent 请求的结果进入该成员上下文。正文与工具事实从目标智能体的 pi JSONL 投影，索引不保存第二份正文。notifications 只读投影实际承接会话内带服务端 featureSource 与 notification marker 的功能通知，按 createdAt 升序；客户端按时间与 turns 合并展示，以 (targetAgentId, sessionId, messageId) 去重，来源头像由 featureId 决定。只展示不广播、不启动模型、不改变普通输入的默认回复对象；用户显式继续处理时传 notification 完整引用，服务端验证当前通知 marker 后交给真实来源 Agent，而非承接方或当前绑定；每条通知独立延续讨论，与普通群输入和私聊隔离。改绑不移动旧通知；reset/delete 后已不存在的当前会话通知不再返回。共用 GET /api/events：ready 和 conversation_updated 后重读群快照，读取中再次失效须补读，正在发送时可延后到发送收口；不另开 SSE 或轮询。GET 可能返回正在生成的半轮，running 标明当前发送；错误不得视为空历史。reset/delete 清理该目标的群聊索引和讨论，不删除其他成员历史。" },
  { operationId: "sendGroupMessage", method: "post" as const, path: "/api/group/messages", summary: "发送聊天消息或继续处理通知", request: groupSendSchema, response: z.unknown(),
    hint: "客户端只传一条新消息，禁止回传群历史。普通聊天的 targetAgentId 仅由显式 @ 选择产生，不能推测目标；未传 notification 且不 @ 时，只有 main 回复。成员向另一成员通信复用 agent 工具，群里展示真实来源与回复，不将历史广播给第三方。目标必须存在，未知目标不回退 main。全群一次只接纳一个用户运行；重复 ID、并发 BUSY 通过 error 帧返回，接纳后的失败也不自动重试。审批仍归执行调用来源的智能体/运行，不能绕过文件审批。notification 与 targetAgentId 互斥；通知上下文首轮由服务端注入为不可信引用，仅存引用索引，后续沿用该通知自己的 discussionId。嵌套请求继承引用；不同通知、普通群聊和私聊不串上下文。原通知失效或已有讨论丢失时报错，不回退 main 或静默另建上下文。文本首批不支持附件；私聊原附件能力不变。",
    sse: { description: "Bearer 鉴权；POST 返回 text/event-stream，每帧只有 data: JSON，JSON.type 为 turn、delta、settled 或 error（无 event:）。每个根/嵌套请求先 turn 再零至多个 delta；以 settled 或 error 结束，无心跳、事件 ID、重放或 Last-Event-ID 恢复。settled 表示执行已收口，具体成功/失败/取消看 GET /api/group 的 turn.status。断流取消当前执行；Stop 绑定根消息 ID，超时/reset/delete/关闭同样取消。EOF 没有终态时视为结果未明，必须 GET /api/group 核对后再解锁，不自动重发。连接/前台恢复均重读群历史，不订阅第二条通知流。", events: groupStreamEvents } },
  { operationId: "stopGroupMessage", method: "post" as const, path: "/api/group/messages/:id/stop", summary: "停止当前群聊运行", response: z.strictObject({ stopped: z.boolean() }),
    hint: "id 为用户根消息 ID；迟到 Stop 不影响后续运行。stopped 只说明发出了取消，需等待原流结束并 GET /api/group 确认收口。已执行副作用不回滚。" },
].map((endpoint) => ({ tag: "群聊", auth: true, ...endpoint }));
