import { z } from "zod";
import { discussionHistoryResponse } from "./space-communication.js";

const spaceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const groupTurnSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), rootId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), sourceSpaceId: spaceId.nullable().describe("null 表示用户；否则是显式请求另一个成员的空间"),
  targetSpaceId: spaceId, discussionId: z.uuid(), createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
});
export const groupSnapshotSchema = z.strictObject({ id: z.literal("main"), defaultSpaceId: z.literal("local-main"), running: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  turns: z.array(groupTurnSchema.extend({ messages: discussionHistoryResponse.shape.messages })) });
export const groupSendSchema = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe("客户端本次发送的稳定 ID；已接纳的 ID 不可重发，先回读核对"),
  content: z.string().trim().min(1).max(20000), targetSpaceId: spaceId.optional().describe("仅显式 @ 选中成员时发送；省略只交给 local-main，不广播、不按内容猜路由。每条消息至多一个目标。") });
export const groupStreamEvents = {
  turn: z.strictObject({ type: z.literal("turn"), turn: groupTurnSchema }),
  delta: z.strictObject({ type: z.literal("delta"), id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), text: z.string() }),
  settled: z.strictObject({ type: z.literal("settled") }),
  error: z.strictObject({ type: z.literal("error"), code: z.string(), message: z.string() }),
};
export const groupEndpoints = [
  { operationId: "getGroupChat", method: "get" as const, path: "/api/group", summary: "读取默认群聊", response: groupSnapshotSchema,
    hint: "固定一个 main 群组，成员目录使用 GET /api/members。群组不是 Space：只统一展示发到群里的消息，绝不拼接私聊或将群时间线注入模型。每个成员的群聊讨论与私聊上下文独立；只有发给它的消息及它显式 space 请求的结果进入该成员上下文。正文与工具事实从目标空间的 pi JSONL 投影，索引不保存第二份正文。GET 可能返回正在生成的半轮，running 标明当前发送；错误不得视为空历史。reset/delete 清理该目标的群聊索引和讨论，不删除其他成员历史。" },
  { operationId: "sendGroupMessage", method: "post" as const, path: "/api/group/messages", summary: "在群聊发消息（默认 main，显式 @ 才定向）", request: groupSendSchema, response: z.unknown(),
    hint: "客户端只传一条新消息，禁止回传群历史。targetSpaceId 仅由显式 @ 选择产生，不能推测目标；不 @ 永远只有 main 回复。成员向另一成员通信复用 space 工具，群里展示真实来源与回复，不将历史广播给第三方。目标必须存在，未知目标不回退 main。全群一次只接纳一个用户运行；重复 ID、并发 BUSY 通过 error 帧返回，接纳后的失败也不自动重试。审批仍归执行调用来源的空间/运行，不能绕过文件审批。文本首批不支持附件；私聊原附件能力不变。",
    sse: { description: "Bearer 鉴权；POST 返回 text/event-stream，每帧只有 data: JSON，JSON.type 为 turn、delta、settled 或 error（无 event:）。每个根/嵌套请求先 turn 再零至多个 delta；以 settled 或 error 结束，无心跳、事件 ID、重放或 Last-Event-ID 恢复。settled 表示执行已收口，具体成功/失败/取消看 GET /api/group 的 turn.status。断流取消当前执行；Stop 绑定根消息 ID，超时/reset/delete/关闭同样取消。EOF 没有终态时视为结果未明，必须 GET /api/group 核对后再解锁，不自动重发。连接/前台恢复均重读群历史，不订阅第二条通知流。", events: groupStreamEvents } },
  { operationId: "stopGroupMessage", method: "post" as const, path: "/api/group/messages/:id/stop", summary: "停止当前群聊运行", response: z.strictObject({ stopped: z.boolean() }),
    hint: "id 为用户根消息 ID；迟到 Stop 不影响后续运行。stopped 只说明发出了取消，需等待原流结束并 GET /api/group 确认收口。已执行副作用不回滚。" },
].map((endpoint) => ({ tag: "群聊", auth: true, ...endpoint }));
