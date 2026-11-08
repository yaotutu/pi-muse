import type { ConversationRecords } from "./types.js";

/**
 * custom result 不进入模型上下文，必须在下一轮 prompt 中显式声明执行边界。
 * 只看当前轮之前最近一个已收口的轮次，不删除工具事实，也不授予旧轮审批或自动续跑权限。
 */
export const buildExecutionBoundary = (
  { turns, results }: ConversationRecords,
  currentRunId: string,
): string | undefined => {
  const previous = turns.findLast((turn) => turn.runId !== currentRunId && results.has(turn.runId));
  if (!previous || results.get(previous.runId)?.status === "completed") return undefined;
  return [
    "Execution boundary for this turn:",
    "The previous turn in this conversation was stopped before completion. Earlier tool results are historical facts only.",
    "Respond to the new message according to its own intent. Do not resume or continue the interrupted work unless the new message explicitly asks you to do so.",
  ].join("\n");
};
