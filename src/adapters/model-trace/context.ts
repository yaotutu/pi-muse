import { AsyncLocalStorage } from "node:async_hooks";
import type { ConversationExecution } from "../../features/conversation/ports.js";

/**
 * 模型调用追踪的显式上下文传播。
 *
 * 唯一 ModelRuntime 的所有请求在到达记录代理时从本模块读取当前归属：
 * 各发起处（主聊天、信息批、群薄路由、会话通信、Dream、子代理）用
 * runWithModelTrace 包住实际驱动模型的异步段。AsyncLocalStorage 保证同进程
 * 并发轮次的 sessionId/kind 不串号；嵌套 run（子代理在父轮工具执行内发起）
 * 以最内层为准。上下文缺失时不丢条目，由记录代理降级为 kind="unlabeled"。
 */
export type ModelTraceKind =
  | "chat"
  | "information:notifications"
  | "information:recommendations"
  | "dream"
  | "subagent"
  | "unlabeled";

export type ModelTraceContext = {
  sessionId: string;
  kind: ModelTraceKind;
  /** 业务标识（runId、discussionId、informationRunId 等）；值必须是可落盘的非敏感字符串。 */
  extra?: Readonly<Record<string, string>>;
};

const storage = new AsyncLocalStorage<ModelTraceContext>();

export const runWithModelTrace = <T>(context: ModelTraceContext, work: () => Promise<T>): Promise<T> =>
  storage.run(context, work);

export const currentModelTraceContext = (): ModelTraceContext | undefined => storage.getStore();

/**
 * conversation 执行适配的旁路包装：只把可能触发模型请求的
 * prompt/waitForIdle/compactIfNeeded 放进追踪上下文，不改变执行、取消与持久化语义。
 */
export const withModelTraceExecution = (
  execution: ConversationExecution,
  context: ModelTraceContext,
): ConversationExecution => ({
  ...execution,
  prompt: (text, images) => runWithModelTrace(context, () => execution.prompt(text, images)),
  waitForIdle: () => runWithModelTrace(context, () => execution.waitForIdle()),
  compactIfNeeded: execution.compactIfNeeded
    ? (instructions) => runWithModelTrace(context, () => execution.compactIfNeeded!(instructions))
    : undefined,
});
