import { z } from "zod";

/** 一期记录的纯 JSON 校验，无 Node 依赖，供读取器与 HTTP 契约共享。 */
export const modelTraceKindSchema = z.enum([
  "chat", "information:notifications", "information:recommendations", "group-routing",
  "agent-communication", "dream", "subagent", "unlabeled",
]);
export const modelTraceRecordSchema = z.object({
  meta: z.object({
    startedAt: z.iso.datetime().describe("调用开始时间，UTC ISO 8601"),
    endedAt: z.iso.datetime().describe("调用结束时间，UTC ISO 8601"),
    durationMs: z.number().nonnegative().describe("调用耗时（毫秒）"),
    agentId: z.string().describe("调用归属智能体；未标注时为 unknown"),
    kind: modelTraceKindSchema.describe("调用场景；unlabeled 表示缺少业务标签"),
    extra: z.record(z.string(), z.string()).optional().describe("额外业务标识，如 runId、discussionId"),
    upstreamOrigin: z.string().describe("上游 origin，不含路径、query 或认证头"),
    httpStatus: z.number().int().optional().describe("上游 HTTP 状态；未获得状态时省略"),
  }),
  request: z.object({
    system: z.string().describe("完整 system prompt，多个 system 消息以换行连接"),
    messages: z.array(z.unknown()).describe("完整供应商消息 JSON，包含角色、内容与工具结果"),
    tools: z.array(z.unknown()).describe("完整工具声明，包含名称、描述和参数 schema"),
    sampling: z.record(z.string(), z.unknown()).describe("模型及可见采样参数"),
    parseError: z.string().optional().describe("请求投影解析失败的诊断"),
  }).optional().describe("请求投影；捕获前失败时可能不存在"),
  response: z.object({
    outputText: z.string().describe("捕获的完整输出文本；截断时仅保留上限内文本"),
    toolCalls: z.array(z.object({ name: z.string(), arguments: z.string().describe("供应商原始参数 JSON 字符串；截断后可能不是合法 JSON") })),
    finishReason: z.string().optional(),
    usage: z.unknown().optional().describe("供应商原始 usage JSON"),
    streamDone: z.boolean().optional().describe("是否捕获到供应商 DONE 帧"),
    errorBody: z.string().optional().describe("上游失败响应正文"),
    truncated: z.boolean().describe("响应是否超过一期捕获上限而截断"),
    disconnected: z.boolean().optional().describe("SDK 客户端是否提前断开"),
    failure: z.string().optional().describe("代理或上游流失败说明"),
  }).optional().describe("响应投影；没有捕获时省略"),
});

/** 单段标识用日目录 + 点 + 原文件名，避免向路径参数开放任意相对路径。 */
export const traceFileNameSchema = z.string().max(512).regex(
  /^\d{4}-\d{2}-\d{2}\.\d{6}-\d{3}-[A-Za-z0-9_-]+-\d{6,}\.json$/,
).describe("完整文件标识：yyyy-mm-dd.HHmmss-sss-agentId-kind-seq.json；只能使用 ASCII 字母、数字、点、下划线和连字符，不接受斜杠、反斜杠或路径穿越。");
