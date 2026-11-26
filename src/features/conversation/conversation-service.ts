import { isMeaningfulExecutionRun, type SessionStatus, type StatusRun, type RunOutcome } from "../workspace/session-status.js";
import { ConversationError, rejectConversation } from "./errors.js";
import { validateConversationInput } from "./validate-input.js";
import type { ConversationDependencies, ConversationExecution } from "./ports.js";
import type { CancelReason, ConversationEvent, ConversationInput, ConversationResult, ConversationTurn, ConversationNotification, ConversationNotificationReceipt, ConversationSnapshot } from "./types.js";
import { attachmentIdentity, buildConversationPrompt } from "./attachments.js";
import { buildExecutionBoundary } from "./execution-boundary.js";

type PendingNotification = {
  notification: ConversationNotification;
  resolve: (receipt: ConversationNotificationReceipt) => void;
  reject: (error: unknown) => void;
  done: Promise<ConversationNotificationReceipt>;
  signal?: AbortSignal;
  cancelQueued?: () => void;
};

const MAX_STREAM_TEXT_BUFFER = 512 * 1024;
const MAX_RECENT_STATUSES = 32;

export type ConversationStreamHandle = {
  done: Promise<void>;
  detach: () => void;
};

type ActiveRun = {
  runId: string;
  sessionId: string;
  assistantId: string;
  isReplay: boolean;
  done: Promise<void>;
  session?: ConversationExecution;
  reason?: CancelReason;
  status?: StatusRun;
  subscribers: Set<(event: ConversationEvent) => void>;
  textBuffer: string;
  started: boolean;
  historyNotified: boolean;
};
// 会话只管理唯一的运行锁和生命周期；执行与历史由组合入口注入，不持有 SDK/store。
export function createConversation(
  config: { configured: boolean; runTimeoutMs: number },
  dependencies: ConversationDependencies,
) {
  const { history: historyPort, openSession } = dependencies;
  const { history, records } = historyPort;
  let active: ActiveRun | undefined;
  let closed = false;
  let closing: Promise<boolean> | undefined;
  const recentStatuses = new Map<string, SessionStatus>();
  const recordRecentStatus = (status: SessionStatus) => {
    recentStatuses.delete(status.runId);
    recentStatuses.set(status.runId, structuredClone(status));
    if (recentStatuses.size > MAX_RECENT_STATUSES) {
      const oldest = recentStatuses.keys().next().value;
      if (oldest) recentStatuses.delete(oldest);
    }
  };
  const notifications = new Map<string, PendingNotification>();
  const receiptOf = (id: string): ConversationNotificationReceipt => ({
    notificationId: id,
    piSessionId: historyPort.piSessionId(),
    messageId: id,
  });
  const removeQueued = (pending: {
    reject: (error: unknown) => void;
    cancelQueued?: () => void;
  }, error: unknown) => {
    pending.cancelQueued?.();
    pending.reject(error);
  };
  const cancelQueuedNotifications = (error: unknown) => {
    for (const pending of [...notifications.values()]) removeQueued(pending, error);
    notifications.clear();
  };
  const publishHistoryChange = () => {
    try {
      dependencies.publishHistoryChange?.({
        sessionId: dependencies.sessionId ?? "main",
        piSessionId: historyPort.piSessionId(),
      });
    } catch { /* 失效推送不改变已成功的持久化结果。 */ }
  };
  const flushNotifications = () => {
    for (const [id, pending] of [...notifications]) {
      if (pending.signal?.aborted) {
        notifications.delete(id);
        removeQueued(pending, new Error("Notification cancelled"));
        continue;
      }
      try {
        if (!history().some((message) => message.id === id)) {
          historyPort.appendNotification(pending.notification);
          // 同 ID 幂等 noop、取消和 append 失败不产生失效事件。
          publishHistoryChange();
        }
        notifications.delete(id);
        pending.resolve(receiptOf(id));
      } catch (error) {
        notifications.delete(id);
        removeQueued(pending, error);
      }
    }
  };
  // 唯一通知入口：稳定 ID 幂等，排队但尚未写入 PI 历史前可被调用方取消。
  const notify = (
    text: string,
    id: string,
    options?: { signal?: AbortSignal; subagentId?: string },
  ): Promise<ConversationNotificationReceipt> => {
    if (closed) return Promise.reject(new Error("Conversation is closed"));
    if (options?.signal?.aborted) return Promise.reject(new Error("Notification cancelled"));
    const existing = notifications.get(id);
    if (existing) return existing.done;
    let resolve!: (receipt: ConversationNotificationReceipt) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<ConversationNotificationReceipt>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const pending: PendingNotification = {
      notification: { id, text, ...(options?.subagentId ? { subagentId: options.subagentId } : {}) },
      resolve,
      reject,
      done,
      signal: options?.signal,
    };
    const cancelQueued = () => options?.signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (notifications.get(id) !== pending) return;
      notifications.delete(id);
      cancelQueued();
      reject(new Error("Notification cancelled"));
    };
    pending.cancelQueued = cancelQueued;
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    notifications.set(id, pending);
    done.then(cancelQueued, cancelQueued);
    if (!active) flushNotifications();
    return done;
  };

  const cancel = async (
    reason: ActiveRun["reason"] = "STOPPED",
    runId?: string,
  ) => {
    const running = active;
    if (!running || (runId && runId !== running.runId)) return false;
    running.reason ??= reason;
    try {
      if (running.session) await running.session.abort();
    } finally {
      await running.done;
    }
    return true;
  };
  // 预检用于 HTTP 在开启 SSE 前返回 400/409；run 再检查一次，防止异步创建流期间争锁。
  const validate = (input: ConversationInput) => {
    if (closed) rejectConversation("SHUTDOWN", "Conversation is closed");
    if (active) rejectConversation("session_locked", "Wait for the current response to stop");
    const validated = validateConversationInput(input, history(), records(), historyPort.checkpoint() ?? "empty");
    if (!config.configured) rejectConversation("MODEL_NOT_CONFIGURED", "Configure the server model before sending");
    return validated;
  };
  const latestStatus = (): SessionStatus | null => {
    if (active?.status) return active.status.snapshot();
    let newestRecent: SessionStatus | undefined;
    for (const entry of recentStatuses.values()) newestRecent = entry;
    const saved = historyPort.sessionStatuses?.().at(-1);
    if (newestRecent && saved) {
      const recentKey = newestRecent.endedAt ?? newestRecent.startedAt;
      const savedKey = saved.endedAt ?? saved.startedAt;
      return recentKey >= savedKey ? structuredClone(newestRecent) : structuredClone(saved);
    }
    if (newestRecent) return structuredClone(newestRecent);
    return saved ? structuredClone(saved) : null;
  };
  const snapshot = async (): Promise<ConversationSnapshot> => {
    // 反馈文件读取前先原子捕获 PI 事实，避免旧消息被配到新 revision。
    const piSessionId = historyPort.piSessionId();
    const messages = history();
    const revision = historyPort.checkpoint() ?? "empty";
    return {
      sessionId: dependencies.sessionId ?? "main",
      piSessionId,
      messages: await dependencies.messages.project(messages),
      revision,
      lastRun: latestStatus(),
    };
  };
  const runTitle = (text: string, source: "chat" | "job") => {
    const compact = text.replace(/\s+/g, " ").trim();
    if (!compact) return source === "job" ? "定时任务" : "聊天执行";
    return compact.length > 60 ? `${compact.slice(0, 59)}…` : compact;
  };
  const isLegacyPlaceholder = (status: SessionStatus) =>
    status.title === "正在处理请求" && status.steps.length === 0;
  const executionRuns = (): SessionStatus[] => {
    const byId = new Map<string, SessionStatus>();
    for (const saved of historyPort.sessionStatuses?.() ?? []) {
      if (isLegacyPlaceholder(saved) || !isMeaningfulExecutionRun(saved)) continue;
      const existing = byId.get(saved.runId);
      if (!existing || saved.revision >= existing.revision) byId.set(saved.runId, structuredClone(saved));
    }
    if (active?.status) {
      const current = active.status.snapshot();
      byId.set(current.runId, current);
    }
    return [...byId.values()].sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId),
    );
  };
  const synthesizeRunStatus = (runId: string): SessionStatus | undefined => {
    const { turns, results } = historyPort.records();
    const turn = turns.findLast((item) => item.runId === runId);
    const result = results.get(runId);
    if (!turn || !result) return undefined;
    const status: RunOutcome =
      result.status === "completed" ? "succeeded" : result.status === "aborted" ? "cancelled" : "failed";
    const stamp = new Date(0).toISOString();
    const source = turn.source ?? "chat";
    return {
      sessionId: dependencies.sessionId ?? "main",
      runId,
      revision: 2,
      source,
      jobId: turn.jobId ?? null,
      title: runTitle(turn.text, source),
      status,
      phase: null,
      label: status === "succeeded" ? "执行完成" : status === "cancelled" ? "执行已停止" : "执行失败",
      tools: [],
      subagents: [],
      pendingApprovalIds: [],
      steps: [],
      startedAt: stamp,
      updatedAt: stamp,
      endedAt: stamp,
    };
  };
  const executionStatus = (runId: string): SessionStatus | undefined => {
    if (active?.runId === runId && active.status) return active.status.snapshot();
    const recent = recentStatuses.get(runId);
    if (recent) return structuredClone(recent);
    const saved = historyPort.sessionStatuses?.().findLast((status) => status.runId === runId);
    if (saved) return structuredClone(saved);
    return synthesizeRunStatus(runId);
  };
  const beginStatus = (sessionId: string, runId: string, source: "chat" | "job", title: string, jobId?: string) => {
    const previous = executionStatus(runId);
    return dependencies.beginStatus?.({ sessionId, runId, source, jobId, title: runTitle(title, source), initialRevision: (previous?.revision ?? 0) + 1 });
  };
  const finishStatus = async (running: ActiveRun, sessionId: string, outcome: RunOutcome, label?: string) => {
    await dependencies.cancelApprovals?.(sessionId, running.runId);
    if (!running.status) return;
    const final = running.status.finish(outcome, label);
    recordRecentStatus(final);
    if (isMeaningfulExecutionRun(final)) {
      historyPort.appendAgentStatus?.(final);
    }
  };
  const settleFailureStatus = (running: ActiveRun, sessionId: string) => {
    if (running.reason === "STOPPED" || running.reason === "SHUTDOWN") {
      return finishStatus(running, sessionId, "cancelled");
    }
    if (running.reason === "TIMEOUT") {
      return finishStatus(running, sessionId, "failed", "处理超时，未生成完整回复");
    }
    return finishStatus(running, sessionId, "failed");
  };
  const broadcast = (running: ActiveRun, event: ConversationEvent) => {
    if (event.type === "run_started") running.started = true;
    if (event.type === "text_delta" && event.delta && running.textBuffer.length < MAX_STREAM_TEXT_BUFFER) {
      const remaining = MAX_STREAM_TEXT_BUFFER - running.textBuffer.length;
      running.textBuffer += event.delta.length <= remaining ? event.delta : event.delta.slice(0, remaining);
    }
    for (const subscriber of [...running.subscribers]) {
      try { subscriber(event); } catch { /* 单个订阅者异常不影响运行与其它订阅者。 */ }
    }
  };
  const startRun = (
    input: ConversationInput,
    emit: (event: ConversationEvent) => void,
  ): ConversationStreamHandle => {
    const currentSessionId = input.sessionId || dependencies.sessionId || "main";
    input.sessionId = currentSessionId;
    const { user, previous, replay } = validate(input);
    let release!: () => void;
    const running: ActiveRun = {
      runId: input.runId,
      sessionId: currentSessionId,
      assistantId: "assistant-" + input.runId,
      isReplay: replay,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
      subscribers: new Set([emit]),
      textBuffer: "",
      started: false,
      historyNotified: false,
    };
    active = running;
    dependencies.messages.setActiveRun(replay ? null : input.runId);
    const emitEvent = (event: ConversationEvent) => broadcast(running, event);
    // 只扣除非审批等待时间；多个审批重叠时，直到最后一个结束才恢复剩余预算。
    // 使用单调时钟计时，不重置预算；Stop/超时/关闭仍直接 cancel，不依赖此 timer。
    let remainingMs = config.runTimeoutMs;
    let countingSince = performance.now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const resumeTimeout = () => {
      countingSince = performance.now();
      timeout = setTimeout(() => {
        void cancel("TIMEOUT", running.runId).catch(() => undefined);
      }, remainingMs);
    };
    resumeTimeout();
    const pendingApprovals = new Set<string>();
    let unsubscribeApprovals: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    const turn: ConversationTurn = {
      userId: user.id,
      text: user.content as string,
      runId: input.runId,
      assistantId: running.assistantId,
      source: "chat",
      ...(user.attachments?.length ? { attachments: user.attachments.map(attachmentIdentity) } : {}),
    };
    let finalReason: string | undefined;
    let status: ConversationResult["status"] = "failed";
    // nanobot 不会因为最终模型回复失败而否认已经完成的工具副作用。
    // 工具结果也可能是拒绝或只读结果，因此只提示“已发生的修改不会回滚”，
    // 不把收到任意工具结果错误地等同于写入成功，不复制 provider 状态或引入事务。
    let toolReturned = false;
    const checkpoint = historyPort.checkpoint();
    let turnRecorded = false;
    const endText = () => emitEvent({ type: "text_end", assistantId: turn.assistantId });
    const notifyHistoryRecorded = () => {
      if (running.historyNotified || historyPort.checkpoint() === checkpoint) return;
      running.historyNotified = true;
      publishHistoryChange();
    };
    void (async () => {
      try {
        // 在打开模型执行前订阅，避免漏掉本轮（含子代理）刚登记的审批。
        unsubscribeApprovals = dependencies.subscribeApprovals?.(currentSessionId, running.runId, ({ id, pending }) => {
          if (pending) {
            if (pendingApprovals.size === 0) {
              clearTimeout(timeout);
              timeout = undefined;
              remainingMs = Math.max(0, remainingMs - (performance.now() - countingSince));
            }
            pendingApprovals.add(id);
          } else if (pendingApprovals.delete(id) && pendingApprovals.size === 0 && !running.reason) {
            resumeTimeout();
          }
        });
        emitEvent({
          type: "run_started",
          assistantId: turn.assistantId,
          sessionId: currentSessionId,
          runId: input.runId,
        });
        if (replay) {
          emitEvent({ type: "history_snapshot", messages: await dependencies.messages.project(history()) });
          status = "completed";
        } else {
          // 初始化或刚开始就停止时，不应先隐藏待重试的旧消息。先打开宿主，
          // 再提交 context edit，并同步宿主内存中的模型上下文。
          running.status = beginStatus(currentSessionId, running.runId, "chat", turn.text);
          running.session = await openSession({ runId: running.runId, status: running.status, userText: turn.text });
          if (running.reason)
            throw new ConversationError(running.reason, "Response cancelled");
          // 只在宿主初始化成功且尚未取消时隐藏待重试轮，保持早停时旧历史可见。
          if (previous) historyPort.omitTurn(previous.runId);
          historyPort.appendTurn(turn);
          turnRecorded = true;
          running.session.syncContext();
          unsubscribe = running.session.subscribe((event) => {
            if (event.type === "turn_start") {
              notifyHistoryRecorded();
              return;
            }
            notifyHistoryRecorded();
            if (event.type === "assistant_end") {
              finalReason = event.reason;
            }
            else {
              if (event.type === "tool_result") toolReturned = true;
              emitEvent(event);
            }
          });
          const prompt = buildConversationPrompt(turn.text, user.attachments);
          // 当前 turn 已落盘；排除本轮，只为实际新执行补充中断边界，幂等重放不提交 prompt。
          const boundary = buildExecutionBoundary(records(), running.runId);
          if (boundary) prompt.prompt = `${boundary}\n\n${prompt.prompt}`;
          await running.session.prompt(prompt.prompt, prompt.images);
          // prompt 完成 + waitForIdle 才允许提交终态；message_end 的 public listener
          // 早于 pi 内部 appendMessage，不能在 listener 内发 RUN_FINISHED。
          await running.session.waitForIdle();
          running.status?.finalizing();
          if (running.reason)
            throw new ConversationError(running.reason, "Response cancelled");
          if (
            finalReason === "error" ||
            finalReason === "aborted" ||
            !finalReason
          )
            throw new ConversationError(
              "MODEL_ERROR",
              "Model request failed. Check the server endpoint, model and API key; then retry.",
            );
          status = "completed";
          endText();
          historyPort.appendResult({
            runId: input.runId,
            status,
          } satisfies ConversationResult);
          await finishStatus(running, currentSessionId, "succeeded");
        }
        emitEvent({
          type: "run_finished",
          sessionId: currentSessionId,
          runId: input.runId,
        });
      } catch (error) {
        if (running.session) {
          await running.session.abort();
          await running.session.waitForIdle();
        }
        // prompt 的前置校验可能早于 user 持久化失败。没有新 user 时恢复旧叶子，
        // 保留追加条目用于审计，但不能让一次失败的重试抹掉原有聊天历史。
        if (turnRecorded) historyPort.restoreIfNoUser(input.runId, checkpoint);
        endText();
        status = running.reason ? "aborted" : "failed";
        historyPort.appendResult({
          runId: input.runId,
          status,
        } satisfies ConversationResult);
        await settleFailureStatus(running, currentSessionId);
        const code =
          running.reason ||
          (error instanceof ConversationError ? error.code : "MODEL_ERROR");
        // 不把供应商响应/URL/凭据直接发给客户端或写入日志，避免 endpoint 错误反射密钥。
        const failureMessage =
          code === "STOPPED"
            ? "Run stopped by user"
            : code === "TIMEOUT"
              ? "Model response timed out; retry when the endpoint is available"
              : code === "SHUTDOWN"
                ? "Response cancelled"
                : "Model request failed. Check server configuration and endpoint availability; then retry.";
        const message = toolReturned
          ? `${failureMessage} Any changes already made by tools were not rolled back. Check the current state before repeating the request.`
          : failureMessage;
        emitEvent({ type: "run_error", code, message });
      } finally {
        clearTimeout(timeout);
        unsubscribeApprovals?.();
        unsubscribe?.();
        try {
          running.session?.dispose();
        } finally {
          // SDK 清理异常也不能悬挂已排队通知，否则 monitor.close 会永远等待投递。
          if (historyPort.checkpoint() !== checkpoint) publishHistoryChange();
          flushNotifications();
          running.subscribers.clear();
          active = undefined;
          dependencies.messages.setActiveRun(null);
          release();
        }
      }
    })();
    return {
      done: running.done,
      detach: () => { running.subscribers.delete(emit); },
    };
  };
  const run = async (
    input: ConversationInput,
    emit: (event: ConversationEvent) => void,
  ) => startRun(input, emit).done;
  const attachStream = (
    runId: string,
    emit: (event: ConversationEvent) => void,
  ): ConversationStreamHandle | null => {
    const running = active;
    if (!running || running.runId !== runId || running.isReplay) return null;
    if (running.started) {
      emit({
        type: "run_started",
        assistantId: running.assistantId,
        sessionId: running.sessionId,
        runId: running.runId,
      });
    }
    if (running.textBuffer.length > 0) {
      emit({ type: "text_delta", delta: running.textBuffer });
    }
    running.subscribers.add(emit);
    return {
      done: running.done,
      detach: () => { running.subscribers.delete(emit); },
    };
  };
  // P4 定时任务触发的服务端轮次：与客户端 run 互斥共用一把锁，但不走 AG-UI
  // emit、不做客户端校验；turn 与结果照常落 pi 历史，并通知客户端读取。
  // 崩溃哲学：失败只诚实标记（result entry），不做断点续跑。
  const trigger = async (
    text: string,
    runId: string,
    options: { signal?: AbortSignal; timeoutMs?: number; jobId?: string; sessionId?: string } = {},
  ) => {
    if (closed || options.signal?.aborted) return { status: "failed" as const, text: "cancelled" };
    if (active) return { status: "failed" as const, text: "busy" };
    const sourceSessionId = dependencies.sessionId ?? options.sessionId ?? "main";
    let release!: () => void;
    const running: ActiveRun = {
      runId,
      sessionId: sourceSessionId,
      assistantId: "assistant-" + runId,
      isReplay: false,
      done: new Promise<void>((resolve) => {
        release = resolve;
      }),
      subscribers: new Set(),
      textBuffer: "",
      started: false,
      historyNotified: false,
    };
    active = running;
    dependencies.messages.setActiveRun(runId);
    const aborted = () => { void cancel("STOPPED", runId).catch(() => undefined); };
    options.signal?.addEventListener("abort", aborted, { once: true });
    // 只有后台 worker 显式提供 timeout；定时 jobs 保持既有的无客户端超时语义。
    const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      void cancel("TIMEOUT", runId).catch(() => undefined);
    }, options.timeoutMs);
    let unsubscribe: (() => void) | undefined;
    let finalReason: string | undefined;
    let finalText = "";
    const turn: ConversationTurn = {
      userId: runId,
      text,
      runId,
      assistantId: "assistant-" + runId,
      source: "job",
      ...(options.jobId ? { jobId: options.jobId } : {}),
    };
    const checkpoint = historyPort.checkpoint();
    try {
      running.status = beginStatus(sourceSessionId, running.runId, "job", text, options.jobId);
      running.session = await openSession({ runId: running.runId, status: running.status, userText: text });
      if (running.reason) throw new ConversationError(running.reason, "Response cancelled");
      historyPort.appendTurn(turn);
      running.session.syncContext();
      unsubscribe = running.session.subscribe((event) => {
        // 工具轮的终止消息可能没有文本，只在非空时覆盖最后一段回复。
        if (event.type === "assistant_end") {
          finalReason = event.reason;
          if (event.text) finalText = event.text;
        }
      });
      await running.session.prompt(text);
      await running.session.waitForIdle();
      running.status?.finalizing();
      const ok = !running.reason && finalReason && finalReason !== "error" && finalReason !== "aborted";
      historyPort.appendResult({
        runId,
        status: ok ? "completed" : "failed",
      } satisfies ConversationResult);
      if (ok) await finishStatus(running, sourceSessionId, "succeeded");
      else await settleFailureStatus(running, sourceSessionId);
      return { status: ok ? ("completed" as const) : ("failed" as const), text: finalText };
    } catch {
      if (running.session) {
        await running.session.abort();
        await running.session.waitForIdle();
      }
      historyPort.appendResult({
        runId,
        status: "failed",
      } satisfies ConversationResult);
      await settleFailureStatus(running, sourceSessionId);
      return { status: "failed" as const, text: "" };
    } finally {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", aborted);
      unsubscribe?.();
      try {
        running.session?.dispose();
      } finally {
        if (historyPort.checkpoint() !== checkpoint) publishHistoryChange();
        flushNotifications();
        active = undefined;
        dependencies.messages.setActiveRun(null);
        release();
      }
    }
  };
  return {
    piSessionId: () => historyPort.piSessionId(),
    messages: dependencies.messages,
    executionStatus,
    executionRuns,
    history,
    snapshot: () => snapshot(),
    validate,
    startRun,
    run,
    attachStream,
    trigger,
    notify,
    cancel,
    isRunning: () => Boolean(active),
    close: () => {
      closed = true;
      cancelQueuedNotifications(new Error("Conversation is closed"));
      return closing ??= cancel("SHUTDOWN");
    },
  };
}
export type Conversation = Awaited<ReturnType<typeof createConversation>>;
