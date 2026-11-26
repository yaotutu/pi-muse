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

const clipSummary = (value: string, max = MAX_STEP_TEXT_LENGTH): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/**
 * 判断一次运行是否包含值得持久化到“执行记录”的真实动作或异常：
 * - 普通纯文字问答（聊天来源且正常完成、未调用工具/子代理/审批）不写入执行账本；
 * - 任何进行中运行、定时任务、包含步骤/子代理/工具调用、或失败/中断的运行均保留。
 */
export const isMeaningfulExecutionRun = (status: SessionStatus): boolean => {
  if (status.status === "running" || status.source === "job") return true;
  if (status.steps.length > 0 || status.subagents.length > 0 || status.tools.length > 0) return true;
  return status.status === "failed" || status.status === "cancelled";
};

/** 从真实步骤提炼一句可直接展示的操作摘要（如“搜索网页（天气） → 写入文件（draft.md）”）。 */
export const summarizeRunSteps = (steps: readonly RunStep[]): string | null => {
  if (!steps.length) return null;
  type Entry = { kind: RunStepKind; toolName: string | null; title: string; detail: string | null; outcomeSuffix?: string };
  const entries: Entry[] = [];
  for (const step of steps) {
    const title = step.title.replace(/\s+/g, " ").trim() || "执行步骤";
    const detail = step.detail?.replace(/\s+/g, " ").trim() || null;
    if (step.kind === "file_commit" && entries.length > 0) {
      const prev = entries[entries.length - 1]!;
      const isMatchingFileTool =
        prev.kind === "tool" &&
        (prev.toolName === "write" || prev.toolName === "edit" || prev.title === "写入文件" || prev.title === "编辑文件") &&
        prev.detail === detail;
      if (isMatchingFileTool) {
        if (step.status === "denied") prev.outcomeSuffix = "已拒绝";
        else if (step.status === "failed") prev.outcomeSuffix = "写入失败";
        continue;
      }
    }
    const suffix =
      step.status === "denied" ? "已拒绝"
      : step.status === "expired" ? "已过期"
      : step.status === "failed" ? "失败"
      : step.status === "cancelled" ? "已取消"
      : undefined;
    entries.push({ kind: step.kind, toolName: step.toolName, title, detail, outcomeSuffix: suffix });
  }
  if (!entries.length) return null;
  const labels = entries.slice(0, 3).map((entry) => {
    const base = entry.detail ? `${entry.title}（${entry.detail}）` : entry.title;
    return entry.outcomeSuffix ? `${base}·${entry.outcomeSuffix}` : base;
  });
  const joined = labels.join(" → ");
  const text = entries.length > 3 ? `${joined} 等 ${entries.length} 步` : joined;
  return clipSummary(text.replace(/\s+/g, " ").trim());
};
