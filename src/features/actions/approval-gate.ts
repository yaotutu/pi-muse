import { ApprovalCapacityError, type ActionService } from "./action-service.js";
import type { ActionKind } from "./types.js";
import type { ExecutionObservation } from "../workspace/session-status.js";

const POLL_INTERVAL_MS = 2_000;

export type ApprovalContext = {
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  subagentId?: string;
};

export type ApprovalActions = Pick<ActionService, "submit" | "poll" | "cancel" | "markExecuting" | "finishExecution">;
export type ApprovalObservation = Extract<ExecutionObservation, { kind: "approval" }>;
export type RunApprovalObserver = {
  observe: (event: ApprovalObservation) => void;
  prefix: string;
};

export type ProposalItem = {
  label: string;
  value: string;
};

export type ProposalPayloadInput = {
  category?: string;
  summary: string;
  target?: string | null;
  items?: ProposalItem[];
  confirmLabel?: string | null;
  denyLabel?: string | null;
};

/** 将建议/通用确认展示参数编码为严格的纯字符串 payload，满足持久化与不可变校验边界。 */
export const encodeProposalPayload = (input: ProposalPayloadInput): Record<string, string> => {
  const payload: Record<string, string> = {
    previewType: "proposal",
    category: input.category?.trim() || "general",
    summary: input.summary,
  };
  if (input.target) payload.target = input.target;
  if (input.items?.length) payload.itemsJson = JSON.stringify(input.items.slice(0, 20));
  if (input.confirmLabel) payload.confirmLabel = input.confirmLabel;
  if (input.denyLabel) payload.denyLabel = input.denyLabel;
  return payload;
};

export type ApprovalGateResult =
  | { status: "approved"; id: string; expiresAt: number }
  | { status: "denied" | "expired" | "cancelled" | "capacity_exceeded"; id?: string };

export type AwaitApprovalOptions = {
  actions: ApprovalActions;
  kind: ActionKind;
  title: string;
  payload: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  context?: ApprovalContext;
  observe?: (event: ApprovalObservation) => void;
  pendingTitle?: string;
  settledTitle?: string;
};

/**
 * 通用人工审批挂起/恢复闸门：提交 pending 记录并轮询等待决定（approve / deny / expired / cancelled），
 * 期间响应 AbortSignal 取消并不延长固定 expiresAt。
 */
export const awaitApproval = async ({
  actions,
  kind,
  title,
  payload,
  timeoutMs,
  signal,
  context,
  observe,
  pendingTitle = "等待人工审批",
  settledTitle = "人工审批",
}: AwaitApprovalOptions): Promise<ApprovalGateResult> => {
  if (signal?.aborted) return { status: "cancelled" };
  let wakeAbort!: () => void;
  const interrupted = new Promise<undefined>((resolve) => { wakeAbort = () => resolve(undefined); });
  signal?.addEventListener("abort", wakeAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const action = await actions.submit(kind, title, payload, {
      ...context,
      timeoutMs,
    });
    observe?.({
      id: `approval:${action.id}`,
      approvalId: action.id,
      kind: "approval",
      phase: "start",
      title: pendingTitle,
      detail: title,
      status: "waiting_approval",
    });
    for (;;) {
      if (signal?.aborted) {
        await actions.cancel(action.id);
        observe?.({ id: `approval:${action.id}`, approvalId: action.id, kind: "approval", phase: "end", status: "cancelled", title: settledTitle, detail: title, result: "审批已取消" });
        return { status: "cancelled", id: action.id };
      }
      const decision = await Promise.race([actions.poll(action.id), interrupted]);
      if (signal?.aborted) {
        await actions.cancel(action.id);
        observe?.({ id: `approval:${action.id}`, approvalId: action.id, kind: "approval", phase: "end", status: "cancelled", title: settledTitle, detail: title, result: "审批已取消" });
        return { status: "cancelled", id: action.id };
      }
      if (decision?.status === "approved") {
        observe?.({ id: `approval:${action.id}`, approvalId: action.id, kind: "approval", phase: "end", status: "succeeded", title: settledTitle, detail: title, result: "已批准" });
        return { status: "approved", id: action.id, expiresAt: Date.parse(action.expiresAt) };
      }
      if (decision?.status !== "pending") {
        const status = decision?.status === "denied" ? "denied" : decision?.status === "expired" ? "expired" : "cancelled";
        const result = status === "denied" ? "已拒绝" : status === "expired" ? "审批已过期" : "审批已取消";
        observe?.({ id: `approval:${action.id}`, approvalId: action.id, kind: "approval", phase: "end", status, title: settledTitle, detail: title, result });
        return { status, id: action.id };
      }
      await Promise.race([
        new Promise<void>((resolve) => { timer = setTimeout(resolve, POLL_INTERVAL_MS); }),
        interrupted,
      ]);
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof ApprovalCapacityError) return { status: "capacity_exceeded" };
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", wakeAbort);
  }
};
