/** 运行与通知契约共用限制；此模块只含定义，浏览器不应为读取限制加载服务端投影和计时器。 */
export const MAX_CURRENT_RUNS = 32;
export const MAX_STATUS_TOOLS = 64;
export const MAX_STATUS_SUBAGENTS = 64;
export const MAX_STATUS_STEPS = 128;
export const MAX_STEP_TEXT_LENGTH = 300;

export const agentPhases = ["preparing", "waiting_model", "responding", "executing_tool", "waiting_subagents", "waiting_approval", "finalizing"] as const;
export type SessionPhase = typeof agentPhases[number];
export type RunOutcome = "succeeded" | "failed" | "cancelled";
export const runStepKinds = ["tool", "subagent", "approval", "file_commit"] as const;
export type RunStepKind = typeof runStepKinds[number];
export const runStepStatuses = ["queued", "running", "waiting_approval", "succeeded", "failed", "denied", "expired", "cancelled"] as const;
export type RunStepStatus = typeof runStepStatuses[number];

export type RunStep = {
  id: string;
  parentId: string | null;
  kind: RunStepKind;
  title: string;
  detail: string | null;
  status: RunStepStatus;
  result: string | null;
  toolName: string | null;
  approvalId: string | null;
  startedAt: string;
  endedAt: string | null;
};

export type AgentToolState = { toolCallId: string; name: string | null; label: string; status: "running" | "waiting_approval"; subagentId: string | null };
export type SubagentState = {
  id: string; role: string; status: "queued" | "running" | RunOutcome;
  phase: Exclude<SessionPhase, "waiting_subagents"> | null; label: string;
  startedAt: string | null; updatedAt: string; endedAt: string | null;
};
export type SessionStatus = {
  sessionId: string; runId: string; revision: number;
  source: "chat" | "job"; jobId: string | null; title: string;
  status: "running" | RunOutcome; phase: SessionPhase | null; label: string;
  tools: AgentToolState[]; subagents: SubagentState[]; pendingApprovalIds: string[];
  steps: RunStep[];
  startedAt: string; updatedAt: string; endedAt: string | null;
};
export type ExecutionObservation =
  | { kind: "model"; phase: "start" | "responding" | "end"; subagentId: string | null }
  | {
      kind: "tool";
      phase: "start" | "end";
      toolCallId: string;
      name: string | null;
      subagentId: string | null;
      title?: string;
      detail?: string | null;
      status?: "succeeded" | "failed" | "denied";
      result?: string | null;
      stepId?: string;
      parentId?: string | null;
    }
  | {
      kind: "subagent";
      phase: "queued" | "start" | "end";
      id: string;
      role: string;
      parentId?: string | null;
      outcome?: RunOutcome;
      result?: string | null;
    }
  | {
      kind: "approval";
      phase: "start" | "end";
      id: string;
      approvalId: string;
      parentId?: string | null;
      title: string;
      detail?: string | null;
      status?: "waiting_approval" | "succeeded" | "denied" | "expired" | "cancelled";
      result?: string | null;
    }
  | {
      kind: "file_commit";
      phase: "end";
      id: string;
      parentId?: string | null;
      title: string;
      detail?: string | null;
      status: "succeeded" | "failed" | "denied";
      result: string | null;
    };
export type StatusRun = {
  observe: (event: ExecutionObservation) => void;
  finalizing: () => void;
  finish: (outcome: RunOutcome, label?: string) => SessionStatus;
  snapshot: () => SessionStatus;
};
