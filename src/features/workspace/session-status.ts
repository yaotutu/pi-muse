import type { ActivityOverview } from "../activities/types.js";

/** 运行与通知契约共用限制；此模块只含定义，浏览器不应为读取限制加载服务端投影和计时器。 */
export const MAX_CURRENT_RUNS = 32;
export const MAX_TRACKED_ACTIVITIES = 64;
export const MAX_STATUS_TOOLS = 64;
export const MAX_STATUS_SUBAGENTS = 64;

export const agentPhases = ["preparing", "waiting_model", "responding", "executing_tool", "waiting_subagents", "waiting_approval", "finalizing"] as const;
export type SessionPhase = typeof agentPhases[number];
export type RunOutcome = "succeeded" | "failed" | "cancelled";
export type AgentToolState = { toolCallId: string; name: string | null; label: string; status: "running" | "waiting_approval"; subagentId: string | null };
export type SubagentState = {
  id: string; role: string; status: "queued" | "running" | RunOutcome;
  phase: Exclude<SessionPhase, "waiting_subagents"> | null; label: string;
  startedAt: string | null; updatedAt: string; endedAt: string | null;
};
export type SessionStatus = {
  activityId: string | null; sessionId: string; runId: string; revision: number;
  source: "chat" | "job"; jobId: string | null; title: string;
  status: "running" | RunOutcome; phase: SessionPhase | null; label: string;
  tools: AgentToolState[]; subagents: SubagentState[]; pendingApprovalIds: string[];
  startedAt: string; updatedAt: string; endedAt: string | null;
};
export type ExecutionObservation =
  | { kind: "model"; phase: "start" | "responding" | "end"; subagentId: string | null }
  | { kind: "tool"; phase: "start" | "end"; toolCallId: string; name: string | null; subagentId: string | null }
  | { kind: "subagent"; phase: "queued" | "start" | "end"; id: string; role: string; outcome?: RunOutcome };
export type StatusRun = {
  observe: (event: ExecutionObservation) => void;
  activity: (overview: ActivityOverview) => void;
  finalizing: () => void;
  finish: (outcome: RunOutcome) => SessionStatus;
  snapshot: () => SessionStatus;
};
