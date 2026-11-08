import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createModelTraceStore, type ModelTraceRecord } from "./store.js";
import { currentModelTraceContext, type ModelTraceContext } from "./context.js";

/** 单条响应捕获上限：超限截断并标记 truncated，防止病态流把磁盘写爆。 */
const CAPTURE_LIMIT = 2 * 1024 * 1024;
/**
 * 调用方上下文经此头跨越回环 HTTP 边界：值只是进程内注册表的不透明 id，
 * 不含 agentId/kind 正文；代理消费后立即删除，且永不转发给上游或写进 trace。
 */
const TRACE_ID_HEADER = "x-pi-muse-trace-id";
/** 逐跳/由传输层重算的头不转发；其余请求头原样透传，且永不进入任何 trace 字段。 */
const skippedRequestHeaders = new Set(["host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade", "expect", TRACE_ID_HEADER]);
const skippedResponseHeaders = new Set(["content-length", "transfer-encoding", "connection", "keep-alive"]);
/** 注册表兜底：请求未到达代理（连接失败等）时条目按时间过期，不做无界增长。 */
const PENDING_CONTEXT_TTL_MS = 60_000;
const PENDING_CONTEXT_MAX = 1024;

type PendingEntry = { context: ModelTraceContext; registeredAt: number };
const pendingContexts = new Map<string, PendingEntry>();

const registerPendingTraceContext = (context: ModelTraceContext): string => {
  if (pendingContexts.size >= PENDING_CONTEXT_MAX) {
    const now = Date.now();
    for (const [id, entry] of pendingContexts) {
      if (now - entry.registeredAt > PENDING_CONTEXT_TTL_MS) pendingContexts.delete(id);
    }
    if (pendingContexts.size >= PENDING_CONTEXT_MAX) pendingContexts.clear();
  }
  const id = randomUUID();
  pendingContexts.set(id, { context, registeredAt: Date.now() });
  return id;
};

const takePendingTraceContext = (id: string | undefined): ModelTraceContext | undefined => {
  if (!id) return undefined;
  const entry = pendingContexts.get(id);
  if (entry) pendingContexts.delete(id);
  return entry?.context;
};

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content)
    ? content.map((part) => part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text ?? "") : "").join("")
    : "";

/**
 * 进程内回环记录代理：注册给 ModelRuntime 的 baseUrl 指向这里，代理再原样转发真实供应商。
 *
 * 边界：
 * - 只监听 127.0.0.1 随机端口，不进入任何对外监听；请求头与 Authorization 只透传、绝不记录；
 * - 请求体解析为 system/messages/tools/采样参数投影，上游 URL 只记 origin 不记 path/query；
 * - 流式响应逐块立即转发（不缓冲等待），旁路解析 SSE 聚合文本输出、工具调用与流结束信息；
 * - 记录失败（解析、落盘、目录不可写）只打印一行脱敏摘要，绝不影响模型调用与透传。
 */
export const createModelTraceProxy = async (deps: {
  upstreamBaseUrl: string;
  runtimeApiKey: string;
  dir: string;
  maxTotalBytes: number;
}) => {
  const store = createModelTraceStore({ dir: deps.dir, maxTotalBytes: deps.maxTotalBytes, secrets: [deps.runtimeApiKey] });
  const upstream = new URL(deps.upstreamBaseUrl);
  // 保留上游 base 的路径前缀（如 /v1），SDK 追加 /chat/completions 后代理按原路径转发到上游 origin。
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const pending = new Set<Promise<void>>();
  const active = new Set<AbortController>();
  let closing: Promise<void> | undefined;

  const forwardHeaders = (request: IncomingMessage): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || skippedRequestHeaders.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (closing) {
      response.writeHead(503).end();
      return;
    }
    // 非模型调用的探测类请求（如可用性检查）照常透传，但不产生 trace 条目。
    if (request.method !== "POST") {
      await pipe(request, response, undefined);
      return;
    }
    // AsyncLocalStorage 不跨进程内 HTTP 边界：上下文由 fetch 注记的不透明 id 带过来；
    // id 未知或缺失时降级为 unlabeled，照常记录，绝不因缺标签丢条目。
    const headerId = request.headers[TRACE_ID_HEADER];
    const context = takePendingTraceContext(Array.isArray(headerId) ? headerId[0] : headerId);
    const startedAt = new Date();
    const record: ModelTraceRecord = {
      meta: {
        startedAt: startedAt.toISOString(),
        endedAt: "",
        durationMs: 0,
        agentId: context?.agentId ?? "unknown",
        kind: context?.kind ?? "unlabeled",
        ...(context?.extra ? { extra: { ...context.extra } } : {}),
        upstreamOrigin: upstream.origin,
      },
      response: { outputText: "", toolCalls: [], truncated: false },
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const endedAt = new Date();
      record.meta.endedAt = endedAt.toISOString();
      record.meta.durationMs = endedAt.getTime() - startedAt.getTime();
      store.write(record);
    };
    const capture = record.response!;
    const abort = new AbortController();
    active.add(abort);
    // 客户端（SDK abort/超时/断流）先断开时：标记 disconnected、中止上游、保留已捕获内容。
    response.once("close", () => {
      if (!response.writableEnded) {
        capture.disconnected = true;
        abort.abort();
      }
    });
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      try {
        const body = JSON.parse(raw) as { messages?: unknown[]; tools?: unknown[] } & Record<string, unknown>;
        const messages = Array.isArray(body.messages) ? body.messages : [];
        record.request = {
          system: messages
            .filter((entry) => entry && typeof entry === "object" && (entry as { role?: unknown }).role === "system")
            .map((entry) => textOf((entry as { content?: unknown }).content))
            .join("\n"),
          messages,
          tools: Array.isArray(body.tools) ? body.tools : [],
          sampling: Object.fromEntries(Object.entries(body).filter(([key]) => key !== "messages" && key !== "tools")),
        };
      } catch {
        record.request = { system: "", messages: [], tools: [], sampling: {}, parseError: "request body is not valid JSON" };
      }
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(`${upstream.origin}${request.url ?? "/"}`, {
          method: "POST",
          headers: forwardHeaders(request),
          body: raw,
          signal: abort.signal,
        });
      } catch {
        record.meta.httpStatus = 502;
        capture.failure = "upstream request failed";
        if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Model trace proxy upstream request failed", type: "proxy_error" } }));
        return;
      }
      record.meta.httpStatus = upstreamResponse.status;
      await pipeUpstream(upstreamResponse, response, capture, abort.signal);
    } catch {
      capture.failure ??= "proxy request failed";
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Model trace proxy request failed", type: "proxy_error" } }));
    } finally {
      abort.abort();
      active.delete(abort);
      finish();
    }
  };

  /** 非 POST 请求的无记录透传：探测类调用维持原语义，失败按原状态回给 SDK。 */
  const pipe = async (request: IncomingMessage, response: ServerResponse, signal: AbortSignal | undefined) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = forwardHeaders(request);
    try {
      const upstreamResponse = await fetch(`${upstream.origin}${request.url ?? "/"}`, {
        method: request.method ?? "GET",
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
        ...(signal ? { signal } : {}),
      });
      const passthrough: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, name) => {
        if (!skippedResponseHeaders.has(name)) passthrough[name] = value;
      });
      response.writeHead(upstreamResponse.status, passthrough);
      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          response.write(chunk.value);
        }
      }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  };

  const pipeUpstream = async (
    upstreamResponse: Response,
    response: ServerResponse,
    capture: NonNullable<ModelTraceRecord["response"]>,
    signal: AbortSignal,
  ) => {
    const headers: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, name) => {
      if (!skippedResponseHeaders.has(name)) headers[name] = value;
    });
    response.writeHead(upstreamResponse.status, headers);
    if (!upstreamResponse.body) {
      response.end();
      return;
    }
    const isEventStream = (upstreamResponse.headers.get("content-type") ?? "").includes("text/event-stream");
    const recordErrorBody = !upstreamResponse.ok;
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    const calls = new Map<number, { name: string; arguments: string }>();
    let capturedChars = 0;
    let frameBuffer = "";
    const appendCaptured = (text: string): string => {
      if (capture.truncated) return "";
      const room = CAPTURE_LIMIT - capturedChars;
      const accepted = text.length <= room ? text : text.slice(0, Math.max(room, 0));
      if (text.length > room) capture.truncated = true;
      capturedChars += accepted.length;
      return accepted;
    };
    const consumeFrame = (frame: string) => {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          capture.streamDone = true;
          continue;
        }
        let event: { choices?: Array<{ finish_reason?: string; delta?: { content?: unknown; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> } }>; usage?: unknown };
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.usage !== undefined) capture.usage = event.usage;
        for (const choice of event.choices ?? []) {
          if (choice.finish_reason) capture.finishReason = choice.finish_reason;
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string") capture.outputText += appendCaptured(delta.content);
          for (const call of delta.tool_calls ?? []) {
            const previous = calls.get(call.index ?? 0) ?? { name: "", arguments: "" };
            previous.name += appendCaptured(call.function?.name ?? "");
            previous.arguments += appendCaptured(call.function?.arguments ?? "");
            calls.set(call.index ?? 0, previous);
          }
        }
      }
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        // 先透传再旁路解析：记录不增加流式延迟，也不因解析问题中断透传。
        response.write(chunk.value);
        const text = decoder.decode(chunk.value, { stream: true });
        if (isEventStream) {
          frameBuffer += text;
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(frameBuffer))) {
            const frame = frameBuffer.slice(0, boundary.index);
            frameBuffer = frameBuffer.slice(boundary.index + boundary[0].length);
            consumeFrame(frame);
          }
        } else if (recordErrorBody) {
          capture.errorBody = (capture.errorBody ?? "") + appendCaptured(text);
        } else {
          capture.outputText += appendCaptured(text);
        }
      }
      response.end();
    } catch {
      capture.failure ??= "upstream stream failed";
      response.destroy();
    } finally {
      capture.toolCalls = [...calls.values()];
      await reader.cancel().catch(() => undefined);
    }
  };

  const server = createServer((request, response) => {
    const work = handle(request, response);
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model trace proxy address missing");
  const origin = `http://127.0.0.1:${(address as AddressInfo).port}`;

  // 范围受限的 fetch 注记：只在调用方异步上下文内、且目标正是本代理时附加 id 头，
  // 其余 fetch 原样放行。上下文缺失（如后台预热）不强注，代理侧降级 unlabeled。
  // 单进程顺序创建/关闭代理时可正确还原；重叠使用时注记可能丢失，仅降级不影响请求。
  const originalFetch = globalThis.fetch.bind(globalThis);
  const annotatedFetch = ((input: unknown, init?: unknown) => {
    try {
      const url = typeof input === "string" ? input
        : input instanceof URL ? input.href
          : input instanceof Request ? input.url
            : undefined;
      if (url?.startsWith(`${origin}/`)) {
        const context = currentModelTraceContext();
        if (context) {
          const id = registerPendingTraceContext(context);
          if (typeof input === "string" || input instanceof URL) {
            const headers = new Headers((init as RequestInit | undefined)?.headers);
            headers.set(TRACE_ID_HEADER, id);
            return originalFetch(input, { ...(init as RequestInit | undefined), headers });
          }
          if (input instanceof Request) {
            const headers = new Headers(input.headers);
            headers.set(TRACE_ID_HEADER, id);
            return originalFetch(new Request(input, { headers }), init as RequestInit | undefined);
          }
        }
      }
    } catch {
      // 注记失败按无上下文请求处理，绝不影响模型调用本身。
    }
    return originalFetch(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
  }) as typeof fetch;
  globalThis.fetch = annotatedFetch;

  return {
    /** 注册进 ModelRuntime 的 baseUrl：回环地址 + 与真实上游一致的路径前缀。 */
    providerBaseUrl: `${origin}${basePath}`,
    close: () => closing ??= (async () => {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...pending]);
      await store.close();
      if (globalThis.fetch === annotatedFetch) globalThis.fetch = originalFetch;
    })(),
  };
};
