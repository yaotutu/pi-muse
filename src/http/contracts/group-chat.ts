import { z } from "zod";
import { discussionHistoryResponse } from "./agent-communication.js";

const agentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const groupSettingsSchema = z.strictObject({ name: z.string().trim().min(1).max(80), purpose: z.string().max(1000),
  memberIds: z.array(agentId).min(1).max(100), defaultAgentId: agentId, instructions: z.string().max(4000) });
export const capabilitySchema = z.strictObject({ capability: z.string().max(1000).describe("公开能力描述，与内部指令、私有记忆分开；空串表示不声明专门职责") });
export const capabilityResponse = capabilitySchema.extend({ agentId });
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
export const groupSnapshotSchema = z.strictObject({ id: z.literal("main"), defaultAgentId: agentId, memberIds: z.array(agentId), running: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  turns: z.array(groupTurnSchema.extend({ messages: discussionHistoryResponse.shape.messages })),
  notifications: z.array(groupNotificationSchema).describe("当前承接会话中来源已验证的功能通知；只读展示；仅显式继续处理时将服务端核实的来源作为引用背景传给来源 Agent") });
export const groupSendSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe("客户端本次发送的稳定 ID；已接纳的 ID 不可重发，先回读核对"),
  content: z.string().min(1).max(20000).refine((value) => !!value.trim(), "Message cannot be blank").describe("保留原文，包括首尾空白；只拒绝全空白消息，不在确认前改写正文"), targetAgentId: agentId.optional().describe("显式 @ 或用户确认选择的成员；优先级最高并跳过模型路由。省略时明确唯一匹配自动按 @ 投递，模糊或多匹配只返回 suggestion 待选择，普通聊天交组的 defaultAgentId；不广播。每条消息至多一个目标。"),
  notification: notificationReferenceSchema.optional().describe("继续处理已验证通知；与 targetAgentId 互斥。服务端验证当前会话的通知 marker，决定真实来源 Agent；改绑不改变旧通知，失效不回退 main。")
}).refine((input) => !(input.notification && input.targetAgentId), { message: "notification and targetAgentId are mutually exclusive" });
export const groupStreamEvents = {
  suggestion: z.strictObject({ type: z.literal("suggestion"), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), content: z.string().min(1).max(20000),
    targetAgentIds: z.array(agentId).min(1).max(100), reason: z.string().max(500) }).describe("模糊或多匹配时仅返回建议，不创建目标执行。保留原文，用户选择后用新的 id 和显式 targetAgentId 发送；取消不发送；不自动重试。"),
  turn: z.strictObject({ type: z.literal("turn"), turn: groupTurnSchema }),
  delta: z.strictObject({ type: z.literal("delta"), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), text: z.string() }),
  settled: z.strictObject({ type: z.literal("settled") }),
  error: z.strictObject({ type: z.literal("error"), code: z.string(), message: z.string() }),
};
export const groupEndpoints = [
  { operationId: "getGroupSettings", method: "get" as const, path: "/api/group/settings", summary: "读取默认组协作设置", response: groupSettingsSchema,
    hint: "当前只配置一个默认组；缺失配置时成员取现有目录、默认 local-main。保存后成员显式管理，新建 Agent 不自动入组。移出成员不删除其历史或私有数据，历史仍可查看。" },
  { operationId: "saveGroupSettings", method: "put" as const, path: "/api/group/settings", summary: "保存默认组成员与路由配置", request: groupSettingsSchema, response: groupSettingsSchema,
    hint: "完整保存，最后成功保存生效。默认回复者必须是成员，成员必须存在且不能重复。发送或路由中返回 BUSY。协作说明只用于当前组，不覆盖成员指令，不改变审批。显式 @ 优先、明确唯一匹配自动转交、模糊或多匹配询问。" },
  { operationId: "getAgentCapability", method: "get" as const, path: "/api/agents/:agentId/capability", summary: "读取智能体公开能力描述", response: capabilityResponse,
    hint: "只读取已存在 Agent 的公开职责，不返回其私有指令、消息或记忆；不存在返回 404，不创建智能体。内置新闻和短信同样可以编辑能力说明。" },
  { operationId: "saveAgentCapability", method: "put" as const, path: "/api/agents/:agentId/capability", summary: "保存智能体公开能力描述", request: capabilitySchema, response: capabilityResponse,
    hint: "用户手动编辑公开职责，最后成功保存生效；不是修改指令或技能授权，下次路由读取最新说明。不存在返回 404，不创建或复活智能体。" },
  { operationId: "getGroupChat", method: "get" as const, path: "/api/group", summary: "读取默认群聊", response: groupSnapshotSchema,
    hint: "当前一个 main 默认组，成员和默认回复者由 /api/group/settings 配置；成员目录使用 GET /api/agents。群组不是 Agent：绝不拼接普通私聊或将群时间线注入模型。每个成员的群聊讨论与私聊上下文独立；只有发给它的消息及它显式 agent 请求的结果进入该成员上下文。正文与工具事实从目标智能体的 pi JSONL 投影，索引不保存第二份正文。notifications 只读投影实际承接会话内带服务端 featureSource 与 notification marker 的功能通知，按 createdAt 升序；客户端按时间与 turns 合并展示，以 (targetAgentId, sessionId, messageId) 去重，来源头像由 featureId 决定。只展示不广播、不启动模型、不改变组路由规则；用户显式继续处理时传 notification 完整引用，服务端验证当前通知 marker 后交给真实来源 Agent，而非承接方或当前绑定；每条通知独立延续讨论，与普通群输入和私聊隔离。改绑不移动旧通知；reset/delete 后已不存在的当前会话通知不再返回。共用 GET /api/events：ready 和 conversation_updated 后重读群快照，读取中再次失效须补读，正在发送时可延后到发送收口；不另开 SSE 或轮询。GET 可能返回正在生成的半轮，running 标明当前发送；错误不得视为空历史。reset/delete 清理该目标的群聊索引和讨论，不删除其他成员历史。" },
  { operationId: "sendGroupMessage", method: "post" as const, path: "/api/group/messages", summary: "发送聊天消息或继续处理通知", request: groupSendSchema, response: z.unknown(),
    hint: "客户端只传一条新消息，禁止回传群历史。路由优先级：显式 targetAgentId 最高且不调用路由模型；省略时仅凭本条消息、组配置和成员公开能力判断，明确唯一匹配自动按 @ 投递，模糊或多个匹配返回 suggestion 后 settled，不执行任何目标；普通聊天由组的 defaultAgentId 回复。suggestion 含原文、候选 ID 与原因，客户端展示后由用户选单个目标，使用新 id 和显式 targetAgentId 发送；取消只丢弃建议。自动投递保留原文和用户身份，默认 Agent 不重复代答。路由失败明确 error，不静默交 main，也不重发。成员向另一成员通信复用 agent 工具，群里展示真实来源与回复，不将历史广播给第三方。目标必须存在，未知目标不回退 main。全群一次只接纳一个用户运行；重复 ID、并发 BUSY 通过 error 帧返回，接纳后的失败也不自动重试。审批仍归执行调用来源的智能体/运行，不能绕过文件审批。notification 与 targetAgentId 互斥；通知上下文首轮由服务端注入为不可信引用，仅存引用索引，后续沿用该通知自己的 discussionId。嵌套请求继承引用；不同通知、普通群聊和私聊不串上下文。原通知失效或已有讨论丢失时报错，不回退 main 或静默另建上下文。文本首批不支持附件；私聊原附件能力不变。",
    sse: { description: "Bearer 鉴权；POST 返回 text/event-stream，每帧只有 data: JSON，JSON.type 为 suggestion、turn、delta、settled 或 error（无 event:）。需确认时 suggestion 后 settled，无 turn 或目标执行；明确投递的根/嵌套请求先 turn 再零至多个 delta；以 settled 或 error 结束，无心跳、事件 ID、重放或 Last-Event-ID 恢复。settled 表示执行已收口，具体成功/失败/取消看 GET /api/group 的 turn.status。断流取消当前执行；Stop 绑定根消息 ID，超时/reset/delete/关闭同样取消。EOF 没有终态时视为结果未明，必须 GET /api/group 核对后再解锁，不自动重发。连接/前台恢复均重读群历史，不订阅第二条通知流。", events: groupStreamEvents } },
  { operationId: "stopGroupMessage", method: "post" as const, path: "/api/group/messages/:id/stop", summary: "停止当前群聊运行", response: z.strictObject({ stopped: z.boolean() }),
    hint: "id 为用户根消息 ID；迟到 Stop 不影响后续运行。stopped 只说明发出了取消，需等待原流结束并 GET /api/group 确认收口。已执行副作用不回滚。" },
].map((endpoint) => ({ tag: "群聊", auth: true, ...endpoint }));
