import type { PendingAction } from "../actions/types.js";
import type { BrowserHandoff, BrowserUpdateScope } from "../browser/types.js";
import type { RunStep, RunStepStatus, SessionPhase, SessionStatus, StatusRun } from "./session-status.js";
import { MAX_CURRENT_RUNS, MAX_STATUS_STEPS, MAX_STATUS_SUBAGENTS, MAX_STATUS_TOOLS, MAX_STEP_TEXT_LENGTH, summarizeRunSteps } from "./session-status.js";
import { createSessionPresence, type SessionPresence } from "./session-presence.js";

export type SubagentUpdateScope = "items" | "runs" | "habits" | "preferences" | "settings";
export type WorkspaceUpdate =
  | { event: "session_presence_updated"; presence: SessionPresence }
  | { event: "session_status_updated"; status: SessionStatus }
  | { event: "approval_pending" | "approval_updated"; approval: PendingAction }
  | { event: "session_directory_updated" }
  | { event: "conversation_updated"; conversation: { sessionId: string; piSessionId: string } }
  | { event: "subagent_updated"; subagentId: string; scope: SubagentUpdateScope }
  | { event: "browser_updated"; scope: BrowserUpdateScope; handoff?: BrowserHandoff | null };
type Subscriber = { notify: (event: WorkspaceUpdate) => void; close: () => void };
export class ExecutionCapacityError extends Error {
  constructor() { super("Too many active executions (maximum 32)"); }
}
const copy = <T>(value: T): T => structuredClone(value);
const runKey = (sessionId: string, runId: string) => JSON.stringify([sessionId, runId]);
const labelFor: Record<SessionPhase, string> = {
  preparing: "正在准备执行", waiting_model: "等待模型响应", responding: "正在生成回复",
  executing_tool: "正在执行工具", waiting_subagents: "正在等待子代理", waiting_approval: "等待人工审批", finalizing: "正在保存结果",
};
const toolLabel = (name: string | null) => ({ search_web: "正在搜索资料", web_fetch: "正在读取网页", browser: "正在操作浏览器", read: "正在读取文件", write: "正在写入文件", edit: "正在编辑文件", subagent: "正在委派子代理" }[name ?? ""] ?? "正在执行工具");
const clipStepText = (value: string | null | undefined, max = MAX_STEP_TEXT_LENGTH): string | null => {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
};
const activeStepStatuses = new Set<RunStepStatus>(["queued", "running", "waiting_approval"]);

/** 只保留当前运行的展示投影，不拥有执行锁，不写事件重放日志。 */
export const createWorkspaceEvents = (recency?: { initial: Record<string, string>; save: (value: Record<string, string>) => void }) => {
  const instanceId = crypto.randomUUID();
  const subscribers = new Set<Subscriber>();
  const active = new Map<string, SessionStatus>();
  const approvals = new Map<string, PendingAction>();
  let closed = false;
  const disconnect = (subscriber: Subscriber) => {
    subscribers.delete(subscriber);
    try { subscriber.close(); } catch { /* 网络订阅不改变业务执行结果。 */ }
  };
  const publish = (event: WorkspaceUpdate) => {
    if (closed) return;
    for (const subscriber of [...subscribers]) {
      try { subscriber.notify(copy(event)); } catch { disconnect(subscriber); }
    }
  };
  const liveRuns = new Map<string, { refreshApprovals: () => void }>();
  const presence = createSessionPresence((value) => publish({ event: "session_presence_updated", presence: value }), recency?.initial, recency?.save);
  return {
    instanceId,
    presence,
    current: (): SessionStatus[] => [...active.values()].map(copy),
    pending: (): PendingAction[] => [...approvals.values()].filter((item) => Date.parse(item.expiresAt) > Date.now()).map(copy),
    subscribe: (subscriber: Subscriber): (() => void) => {
      if (closed) { disconnect(subscriber); return () => {}; }
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
    seedApprovals: (items: PendingAction[]) => {
      approvals.clear();
      for (const item of items) if (item.status === "pending") {
        approvals.set(item.id, copy(item));
        const owner = item.sessionId;
        if (owner && Date.parse(item.expiresAt) > Date.now()) presence.set(owner, `approval:${item.id}`, { state: "waiting", label: "等待你审批文件修改" });
      }
    },
    approvalChanged: (item: PendingAction) => {
      if (closed) return;
      const newlyPending = item.status === "pending" && !approvals.has(item.id);
      if (item.status === "pending") approvals.set(item.id, copy(item));
      else approvals.delete(item.id);
      const owner = item.sessionId;
      if (owner) presence.set(owner, `approval:${item.id}`, item.status === "pending" && Date.parse(item.expiresAt) > Date.now() ? { state: "waiting", label: "等待你审批文件修改" } : null, newlyPending);
      publish({ event: item.status === "pending" ? "approval_pending" : "approval_updated", approval: item });
      const targetAgent = item.sessionId;
      if (targetAgent && item.runId) liveRuns.get(runKey(targetAgent, item.runId))?.refreshApprovals();
    },
    sessionDirectoryChanged: () => publish({ event: "session_directory_updated" }),
    /** 权威历史提交后发出身份失效信号，客户端按会话重读。 */
    conversationHistoryChanged: (conversation: { sessionId: string; piSessionId: string }) => {
      if (closed) return;
      publish({ event: "conversation_updated", conversation });
    },
    /** 专职 Subagent 数据（条目、运行、习惯、偏好或设置）变更时的轻量失效信号。 */
    subagentChanged: (subagentId: string, scope: SubagentUpdateScope) => {
      if (closed) return;
      publish({ event: "subagent_updated", subagentId, scope });
    },
    /** 真实浏览器标签、视口、文件或人工接管状态变更时的轻量通知。 */
    browserChanged: (scope: BrowserUpdateScope, handoff?: BrowserHandoff | null) => {
      if (closed) return;
      publish({ event: "browser_updated", scope, ...(handoff !== undefined ? { handoff } : {}) });
    },
    beginRun: (input: { sessionId?: string; runId: string; source: "chat" | "job"; jobId?: string | null; title?: string; initialRevision?: number; onChange?: (status: SessionStatus) => void }): StatusRun => {
      if (closed) throw new Error("Service is closing");
      if (active.size >= MAX_CURRENT_RUNS) throw new ExecutionCapacityError();
      const sessionId = input.sessionId ?? "main";
      const key = runKey(sessionId, input.runId);
      if (active.has(key)) throw new Error("Execution already active");
      const now = new Date().toISOString();
      // 每次新执行替换同来源的旧错误，不让已重试问题继续亮红。
      const presenceKey = `run:${input.source}`;
      let ended = false;
      let parentPhase: SessionPhase = "preparing";
      let state: SessionStatus = {
        sessionId, runId: input.runId, source: input.source, jobId: input.jobId ?? null,
        revision: input.initialRevision ?? 1, title: (input.title || (input.source === "job" ? "定时任务" : "聊天执行")).slice(0, 500), status: "running", phase: "preparing", label: labelFor.preparing,
        tools: [], subagents: [], pendingApprovalIds: [], steps: [], startedAt: now, updatedAt: now, endedAt: null,
      };
      const notify = (increment = true) => {
        if (increment) state.revision++;
        state.updatedAt = new Date().toISOString();
        if (!ended) active.set(key, copy(state));
        // 展示通知错误不能中断模型或已完成的工具；持久终态由协调器另行提交。
        try { input.onChange?.(copy(state)); } catch { /* 观察出口不拥有运行生命周期。 */ }
        publish({ event: "session_status_updated", status: state });
        presence.set(sessionId, presenceKey, ended
          ? state.status === "failed" ? { state: "error", label: "执行失败，请查看执行记录与审批" } : null
          : { state: state.phase === "waiting_approval" ? "waiting" : "working", label: state.label }, (ended && state.status === "succeeded") || (!increment && input.source === "chat"));
      };
      const upsertStep = (draft: {
        id: string;
        parentId: string | null;
        kind: RunStep["kind"];
        title: string;
        detail?: string | null;
        status: RunStepStatus;
        result?: string | null;
        toolName?: string | null;
        approvalId?: string | null;
        startedAt?: string;
        endedAt?: string | null;
      }) => {
        const existing = state.steps.find((item) => item.id === draft.id);
        const title = clipStepText(draft.title) ?? "执行步骤";
        const detail = clipStepText(draft.detail);
        const result = clipStepText(draft.result);
        if (existing) {
          existing.parentId = draft.parentId ?? existing.parentId;
          existing.title = title;
          if (draft.detail !== undefined) existing.detail = detail;
          existing.status = draft.status;
          if (draft.result !== undefined) existing.result = result;
          if (draft.toolName !== undefined) existing.toolName = draft.toolName;
          if (draft.approvalId !== undefined) existing.approvalId = draft.approvalId;
          if (draft.endedAt !== undefined) existing.endedAt = draft.endedAt;
          return;
        }
        if (state.steps.length >= MAX_STATUS_STEPS) {
          const dropIdx = state.steps.findIndex((item) => item.endedAt !== null);
          if (dropIdx >= 0) state.steps.splice(dropIdx, 1);
          else return;
        }
        state.steps.push({
          id: draft.id.slice(0, 200),
          parentId: draft.parentId ? draft.parentId.slice(0, 200) : null,
          kind: draft.kind,
          title,
          detail,
          status: draft.status,
          result,
          toolName: draft.toolName ?? null,
          approvalId: draft.approvalId ?? null,
          startedAt: draft.startedAt ?? new Date().toISOString(),
          endedAt: draft.endedAt ?? null,
        });
      };
      const refresh = () => {
        if (ended) return;
        const waiting = [...approvals.values()].filter((item) => item.sessionId === state.sessionId && item.runId === state.runId && Date.parse(item.expiresAt) > Date.now());
        state.pendingApprovalIds = waiting.map((item) => item.id);
        for (const tool of state.tools) {
          const isWaiting = waiting.some((item) => item.toolCallId === tool.toolCallId && item.subagentId === tool.subagentId);
          tool.status = isWaiting ? "waiting_approval" : "running";
          const stepId = `${tool.subagentId ?? "main"}:tool:${tool.toolCallId}`;
          const step = state.steps.find((entry) => entry.id === stepId && entry.endedAt === null);
          if (step) step.status = isWaiting ? "waiting_approval" : "running";
        }
        for (const child of state.subagents) if (child.status === "running" && waiting.some((item) => item.subagentId === child.id)) { child.phase = "waiting_approval"; child.label = labelFor.waiting_approval; }
        state.phase = waiting.length ? "waiting_approval"
          : state.subagents.some((item) => item.status === "running" || item.status === "queued") ? "waiting_subagents"
          : state.tools.some((item) => item.subagentId === null) ? "executing_tool" : parentPhase;
        state.label = state.phase === "executing_tool" ? state.tools.find((item) => item.subagentId === null)?.label ?? labelFor.executing_tool : labelFor[state.phase];
        notify();
      };
      active.set(key, copy(state));
      liveRuns.set(key, { refreshApprovals: refresh });
      notify(false);
      return {
        snapshot: () => copy(state),
        observe: (event) => {
          if (ended) return;
          const stamp = new Date().toISOString();
          if (event.kind === "model") {
            const phase = event.phase === "start" ? "waiting_model" : event.phase === "responding" ? "responding" : "waiting_model";
            if (event.subagentId) {
              const child = state.subagents.find((item) => item.id === event.subagentId);
              if (child && child.status === "running") { child.phase = phase; child.label = labelFor[phase]; child.updatedAt = stamp; }
            } else {
              if (parentPhase === phase && event.phase === "responding") return;
              parentPhase = phase;
            }
          } else if (event.kind === "tool") {
            const stepId = event.stepId ?? `${event.subagentId ?? "main"}:tool:${event.toolCallId}`;
            const label = clipStepText(event.title, 120) ?? toolLabel(event.name);
            const index = state.tools.findIndex((item) => item.toolCallId === event.toolCallId && item.subagentId === event.subagentId);
            if (event.phase === "start") {
              if (index < 0) {
                if (state.tools.length >= MAX_STATUS_TOOLS) throw new ExecutionCapacityError();
                state.tools.push({ toolCallId: event.toolCallId, subagentId: event.subagentId, name: event.name, label, status: "running" });
              }
              upsertStep({
                id: stepId,
                parentId: event.parentId ?? event.subagentId ?? null,
                kind: "tool",
                title: event.title ?? label,
                detail: event.detail ?? null,
                status: "running",
                result: null,
                toolName: event.name,
                startedAt: stamp,
                endedAt: null,
              });
            } else {
              if (index >= 0) state.tools.splice(index, 1);
              upsertStep({
                id: stepId,
                parentId: event.parentId ?? event.subagentId ?? null,
                kind: "tool",
                title: event.title ?? label,
                detail: event.detail,
                status: event.status ?? "succeeded",
                result: event.result ?? "已完成",
                toolName: event.name,
                startedAt: stamp,
                endedAt: stamp,
              });
            }
            if (event.subagentId) {
              const child = state.subagents.find((item) => item.id === event.subagentId);
              if (child && child.status === "running") { child.phase = event.phase === "start" ? "executing_tool" : "waiting_model"; child.label = event.phase === "start" ? label : labelFor.waiting_model; child.updatedAt = stamp; }
            }
          } else if (event.kind === "subagent") {
            let child = state.subagents.find((item) => item.id === event.id);
            if (!child) {
              if (state.subagents.length >= MAX_STATUS_SUBAGENTS) throw new ExecutionCapacityError();
              child = { id: event.id, role: event.role.slice(0, 64), status: "queued", phase: null, label: "等待子代理执行名额", startedAt: null, updatedAt: stamp, endedAt: null };
              state.subagents.push(child);
            }
            if (event.phase === "start") { child.status = "running"; child.phase = "preparing"; child.label = labelFor.preparing; child.startedAt = stamp; }
            if (event.phase === "end") { child.status = event.outcome ?? "failed"; child.phase = null; child.endedAt = stamp; child.label = child.status === "succeeded" ? "子代理已完成" : child.status === "cancelled" ? "子代理已停止" : "子代理失败"; }
            child.updatedAt = stamp;
            upsertStep({
              id: event.id,
              parentId: event.parentId ?? null,
              kind: "subagent",
              title: event.phase === "queued" ? "等待委派子代理" : event.phase === "start" ? "委派子代理" : child.label,
              detail: event.role,
              status: event.phase === "queued" ? "queued" : event.phase === "start" ? "running" : (event.outcome ?? "failed"),
              result: event.phase === "end" ? (event.result ?? child.label) : null,
              startedAt: stamp,
              endedAt: event.phase === "end" ? stamp : null,
            });
          } else if (event.kind === "approval") {
            upsertStep({
              id: event.id,
              parentId: event.parentId ?? null,
              kind: "approval",
              title: event.title,
              detail: event.detail ?? null,
              status: event.phase === "start" ? "waiting_approval" : (event.status ?? "cancelled"),
              result: event.result ?? null,
              approvalId: event.approvalId,
              startedAt: stamp,
              endedAt: event.phase === "end" ? stamp : null,
            });
          } else if (event.kind === "file_commit") {
            upsertStep({
              id: event.id,
              parentId: event.parentId ?? null,
              kind: "file_commit",
              title: event.title,
              detail: event.detail ?? null,
              status: event.status,
              result: event.result,
              startedAt: stamp,
              endedAt: stamp,
            });
          }
          refresh();
        },
        finalizing: () => { if (!ended) { parentPhase = "finalizing"; refresh(); } },
        finish: (outcome, label) => {
          if (ended) return copy(state);
          ended = true;
          const stepSummary = outcome === "succeeded" ? summarizeRunSteps(state.steps) : null;
          state.status = outcome; state.phase = null; state.label = label ?? (outcome === "succeeded" ? (stepSummary ?? "执行完成") : outcome === "cancelled" ? "执行已停止" : "执行失败");
          state.tools = []; state.pendingApprovalIds = [];
          const stamp = new Date().toISOString();
          for (const child of state.subagents) if (child.status === "queued" || child.status === "running") {
            child.status = outcome === "cancelled" ? "cancelled" : "failed"; child.phase = null; child.updatedAt = stamp; child.endedAt = stamp; child.label = "子代理执行结束";
          }
          for (const step of state.steps) {
            if (step.endedAt === null || activeStepStatuses.has(step.status)) {
              step.endedAt ??= stamp;
              step.status = outcome === "cancelled" ? "cancelled" : "failed";
              step.result ??= outcome === "cancelled" ? "运行已停止" : "运行未完成";
            }
          }
          state.endedAt = stamp;
          active.delete(key); liveRuns.delete(key);
          notify();
          return copy(state);
        },
      };
    },
    close: () => {
      if (closed) return;
      closed = true;
      presence.close();
      for (const subscriber of [...subscribers]) disconnect(subscriber);
    },
  };
};
export type WorkspaceEvents = ReturnType<typeof createWorkspaceEvents>;
