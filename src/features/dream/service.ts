import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { createHash, randomUUID } from "node:crypto";
import { ASSISTANT_TEXT_LIMIT } from "../identity/types.js";
import type { ObserveWork } from "../workspace/session-presence.js";
import { MemoryChangedError, MemoryLimitError, MemoryTextError, type MemoryService } from "../memory/memory-service.js";
import { buildDreamInput } from "./prompt.js";
import {
  appendInstructions,
  appendNote,
  planProposal,
  type ProposedChange,
} from "./proposal.js";
import type {
  DreamMessage,
  DreamPending,
  DreamRepository,
  DreamRunStatus,
  DreamState,
  DreamTarget,
} from "./types.js";
import { sliceWindow, splitBatches } from "./window.js";

export type DreamNotesPort = {
  readUser: () => Promise<string>;
  readResolvedUser?: () => Promise<string>;
  writeUserIfUnchanged: (content: string, expected: string) => Promise<boolean>;
  readSoul: () => Promise<string>;
  readResolvedSoul?: () => Promise<string>;
  writeSoulIfUnchanged: (content: string, expected: string) => Promise<boolean>;
  readInstructions: () => Promise<string>;
  readResolvedInstructions?: () => Promise<string>;
  writeInstructionsIfUnchanged: (content: string, expected: string) => Promise<boolean>;
};

export type DreamConversationsPort = {
  listSessionIds: () => Promise<string[]>;
  sessionExists: (sessionId: string) => Promise<boolean>;
  isSessionBusy: (sessionId: string) => Promise<boolean>;
  readTranscript: (
    sessionId: string,
  ) => Promise<{ messages: DreamMessage[]; summary?: string }>;
};

export type DreamProposeResult =
  | { ok: true; changes: ProposedChange[] }
  | { ok: false; error: string };

export type DreamDependencies = {
  observeWork?: ObserveWork;
  waitingChanged?: (sessionId: string, waiting: boolean) => void;
  repository: DreamRepository & { reconcileOnStart: () => Promise<void> };
  notes: DreamNotesPort;
  memory: Pick<MemoryService, "list" | "add" | "edit" | "forget">;
  conversations: DreamConversationsPort;
  propose: (input: {
    /** 目标会话；用于模型调用追踪标注，不参与整理决策。 */
    sessionId: string;
    userPrompt: string;
    signal?: AbortSignal;
  }) => Promise<DreamProposeResult>;
};

export type DreamOverview = DreamState & { intervalHours: number; running: boolean };
export type DreamRunResult = { ok: true; state: DreamOverview } | { ok: false; code: "not_found" | "conflict"; message: string };
export type DreamResolveResult = DreamRunResult;

/** 固定 2 小时周期（毫秒），写成常量，不支持逐会话自定义间隔。 */
export const DREAM_INTERVAL_HOURS = 2;
export const DREAM_INTERVAL_MS = DREAM_INTERVAL_HOURS * 60 * 60 * 1_000;
const PENDING_LIMIT = 50;

/**
 * Dream 后台记忆整理业务服务：
 * - 进程内串行执行，避免多会话同时跑整理轮互相覆盖全局 USER/SOUL/memory；
 * - 游标只在整轮成功后推进，失败不动；
 * - 写入前比对读取时的文本版本，不覆盖用户在整理期间的新改动；
 * - 会话在整理期间被删除时停止提交，绝不因写 dream.json 或 INSTRUCTIONS.md 重建会话。
 */
export const createDreamService = (deps: DreamDependencies) => {
  const { repository, notes, memory, conversations, propose } = deps;
  let activeRun: { sessionId: string; abort: () => void; done: Promise<void> } | undefined;
  let closed = false;
  let dispatching = false;
  const pendingSerial = createSerializedWriter();
  const checkAgentExists = conversations.sessionExists;
  const checkAgentBusy = conversations.isSessionBusy;
  const listSessionIds = conversations.listSessionIds;

  const describeAll = async (): Promise<DreamOverview> => {
    const state = await repository.read();
    deps.waitingChanged?.("main", state.pending.length > 0);
    return { ...state, intervalHours: DREAM_INTERVAL_HOURS, running: Boolean(activeRun) };
  };

  /** 执行单个会话的一轮整理；manual=false（定时扫描）在无新消息时静默跳过，不落盘。 */
  const executeAgent = async (
    sessionId: string,
    manual: boolean,
    outerSignal?: AbortSignal,
  ): Promise<DreamRunResult> => {
    if (closed || outerSignal?.aborted) {
      return { ok: false, code: "conflict", message: "Dream service is closing" };
    }
    if (activeRun) {
      return { ok: false, code: "conflict", message: "A Dream consolidation is already running" };
    }
    if (!(await checkAgentExists(sessionId))) {
      return { ok: false, code: "not_found", message: "Agent not found" };
    }
    if (await checkAgentBusy(sessionId)) {
      return {
        ok: false,
        code: "conflict",
        message: "Wait for the current conversation response to finish before consolidating",
      };
    }

    if (closed || outerSignal?.aborted) return { ok:false,code:"conflict",message:"Dream service is closing" };
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    outerSignal?.addEventListener("abort", forwardAbort, { once: true });
    let finishRun!: () => void;
    activeRun = {
      sessionId,
      abort: () => controller.abort(),
      done: new Promise<void>((resolve) => {
        finishRun = resolve;
      }),
    };
    let finishWork: ReturnType<ObserveWork> | undefined;

    try {
      const initial = await repository.read();
      const transcript = await conversations.readTranscript(sessionId);
      const window = sliceWindow(transcript.messages, initial.cursors[sessionId], transcript.summary);
      const startedAt = new Date().toISOString();

      if (!window.fresh.length) {
        if (manual && (await checkAgentExists(sessionId))) {
          await repository.update( (state) => ({
            state: {
              ...state,
              lastRun: { at: startedAt, status: "completed", changed: [], processed: 0 },
            },
            result: undefined,
          }));
        }
        return { ok: true, state: await describeAll() };
      }

      // 崩溃保护：调用模型前先落盘 running，若进程中途崩溃，下次启动会诚实改为 failed。
      finishWork = deps.observeWork?.(sessionId, "dream", "正在整理记忆");
      await repository.update( (state) => ({
        state: {
          ...state,
          lastRun: {
            at: startedAt,
            status: "running",
            changed: [],
            processed: window.fresh.length,
          },
        },
        result: undefined,
      }));

      const batches = splitBatches(window);
      const changed = new Set<DreamTarget>();
      const addedPending: DreamPending[] = [];
      let hadFailure = false;
      let failureMessage: string | undefined;
      const fail = (message: string) => {
        hadFailure = true;
        failureMessage ??= message;
      };

      for (const batch of batches) {
        if (controller.signal.aborted || closed) {
          fail("Consolidation cancelled");
          break;
        }
        if (!(await checkAgentExists(sessionId))) {
          return { ok: false, code: "not_found", message: "Agent not found" };
        }
        if (await checkAgentBusy(sessionId)) {
          fail("Conversation became busy during consolidation");
          break;
        }

        const [user, soul, instructions, memories] =
          await Promise.all([
            (notes.readResolvedUser ?? notes.readUser)(),
            (notes.readResolvedSoul ?? notes.readSoul)(),
            (notes.readResolvedInstructions ?? notes.readInstructions)(),
            memory.list(),
          ]);
        const userPrompt = buildDreamInput(batch, {
          user,
          soul,
          instructions,
          memories: memories.map((item) => ({ id: item.id, text: item.text })),
        });

        const proposed = await propose({
          sessionId,
          userPrompt,
          signal: controller.signal,
        });
        if (!proposed.ok) {
          fail(proposed.error);
          break;
        }
        if (controller.signal.aborted || closed) {
          fail("Consolidation cancelled");
          break;
        }
        if (!(await checkAgentExists(sessionId))) {
          return { ok: false, code: "not_found", message: "Agent not found" };
        }

        const memoryAtProposal = new Map(memories.map((item) => [item.id, item]));
        const plan = planProposal(proposed.changes, {
          existingMemoryIds: new Set(memoryAtProposal.keys()),
        });

        // 只有记忆建议可直接写入，助手指令及资料始终经全局待决列表确认。
        const existingMemoryTexts = new Set(
          memories.map((entry) => entry.text.replace(/\s+/g, " ").trim()),
        );
        for (const item of plan.apply) {
          if (item.target !== "memory") continue;
          try {
            if (item.op === "add") {
              const normalized = item.text.replace(/\s+/g, " ").trim();
              if (existingMemoryTexts.has(normalized)) continue;
              existingMemoryTexts.add(normalized);
              await memory.add(item.text, `dream:${sessionId}`);
              changed.add("memory");
            } else {
              const expected = memoryAtProposal.get(item.id);
              if (!expected) continue;
              const applied = item.op === "edit"
                ? await memory.edit(item.id, item.text, expected)
                : await memory.forget(item.id, expected);
              if (applied) changed.add("memory");
            }
          } catch (error) {
            fail(
              error instanceof MemoryLimitError || error instanceof MemoryTextError || error instanceof MemoryChangedError
                ? error.message
                : "Failed to update long-term memory",
            );
          }
        }

        const now = new Date().toISOString();
        for (const item of plan.pending) {
          addedPending.push({ ...item, id: randomUUID(), createdAt: now, sourceSessionId: sessionId });
        }
      }

      if (!(await checkAgentExists(sessionId))) {
        return { ok: false, code: "not_found", message: "Agent not found" };
      }

      const outcome = await repository.update((state) => {
        const seen = new Set(
          state.pending.map((item) => `${item.suggestedTarget}:${item.text}`),
        );
        const mergedPending = [...state.pending];
        let pendingFull = false;
        for (const item of addedPending) {
          const key = `${item.suggestedTarget}:${item.text}`;
          if (seen.has(key)) continue;
          if (mergedPending.length >= PENDING_LIMIT) {
            pendingFull = true;
            break;
          }
          seen.add(key);
          mergedPending.push(item);
        }
        const didWrite = changed.size > 0 || mergedPending.length > state.pending.length;
        const error = failureMessage ?? (pendingFull ? "Dream pending queue is full; review pending proposals before continuing" : undefined);
        const status: DreamRunStatus = hadFailure || pendingFull
          ? didWrite ? "partial" : "failed"
          : "completed";
        return {
          state: {
            ...state,
            // 容量以同次存储更新中的队列为准。缺失建议时保留游标，供下次继续整理。
            cursors: status === "completed" && window.lastId ? { ...state.cursors, [sessionId]: window.lastId } : state.cursors,
            lastRun: {
              at: startedAt,
              status,
              changed: [...changed],
              processed: window.fresh.length,
              ...(error ? { error } : {}),
            },
            pending: mergedPending,
          },
          result: { status, didWrite },
        };
      });

      finishWork?.(controller.signal.aborted || closed ? "cancelled" : outcome.status === "completed" ? "succeeded" : "failed", outcome.didWrite);
      return { ok: true, state: await describeAll() };
    } finally {
      finishWork?.(controller.signal.aborted || closed ? "cancelled" : "failed", false);
      outerSignal?.removeEventListener("abort", forwardAbort);
      activeRun = undefined;
      finishRun();
    }
  };

  return {
    reconcileOnStart: () => repository.reconcileOnStart(),
    isBusy: () => dispatching || Boolean(activeRun),
    describeAll,
    updateSettings: async (patch: { enabled: boolean }) => {
      await repository.update((state) => ({ state: { ...state, enabled: patch.enabled }, result: undefined }));
      return describeAll();
    },
    runNow: async (signal?: AbortSignal): Promise<DreamRunResult> => {
      if (closed || dispatching || activeRun) return {ok:false,code:"conflict",message:"A Dream consolidation is already running or closing"};
      dispatching = true;
      try {
        for (const id of await listSessionIds()) {
          const result = await executeAgent(id, true, signal);
          if (!result.ok) return result;
        }
        return { ok: true, state: await describeAll() };
      } finally { dispatching = false; }
    },
    /** 全局入口在首个 await 前争用；逐会话检查忙状态，不创建第二个整理槽。 */
    runScheduledTick: async (signal?: AbortSignal) => {
      if (closed || dispatching || activeRun || signal?.aborted) return;
      dispatching = true;
      try {
        for (const sessionId of await listSessionIds()) {
          if (closed || signal?.aborted) return;
          if (!(await repository.read()).enabled) return;
          if (await checkAgentBusy(sessionId)) continue;
          await executeAgent(sessionId, false, signal);
        }
      } finally { dispatching = false; }
    },
    resolvePending: async (
      pendingId: string,
      decision: { action: "apply"; target?: DreamTarget } | { action: "dismiss" },
    ): Promise<DreamResolveResult> => pendingSerial(async () => {
      const state = await repository.read();
      const found = state.pending.find((item) => item.id === pendingId);
      if (!found) {
        return { ok: false, code: "not_found", message: "Pending item not found" };
      }
      const sessionId = found.sourceSessionId ?? "main";
      if (decision.action === "apply") {
        const target = decision.target ?? found.suggestedTarget;
        try {
          if (target === "user") {
            const current = await notes.readUser();
            const next = appendNote(current, found.text);
            if (next.length > ASSISTANT_TEXT_LIMIT) {
              return { ok: false, code: "conflict", message: "User profile exceeds maximum length" };
            }
            if (next !== current && !(await notes.writeUserIfUnchanged(next, current))) {
              return { ok: false, code: "conflict", message: "User profile changed concurrently; review and retry" };
            }
          } else if (target === "soul") {
            const current = await notes.readSoul();
            const next = appendNote(current, found.text);
            if (next.length > ASSISTANT_TEXT_LIMIT) {
              return { ok: false, code: "conflict", message: "Assistant persona exceeds maximum length" };
            }
            if (next !== current && !(await notes.writeSoulIfUnchanged(next, current))) {
              return { ok: false, code: "conflict", message: "Assistant persona changed concurrently; review and retry" };
            }
          } else if (target === "instructions") {
            const current = await notes.readInstructions();
            const next = appendInstructions(current, found.text);
            if (next.length > ASSISTANT_TEXT_LIMIT) {
              return { ok: false, code: "conflict", message: "Instructions exceed maximum length" };
            }
            if (next !== current && !(await notes.writeInstructionsIfUnchanged(next, current))) {
              return { ok: false, code: "conflict", message: "Assistant instructions changed concurrently; review and retry" };
            }
          } else {
            const memoryId = createHash("sha256").update(`dream:pending:${pendingId}`).digest("hex");
            await memory.add(found.text, `dream:${sessionId}`, memoryId);
          }
        } catch (error) {
          if (error instanceof MemoryLimitError || error instanceof MemoryTextError) {
            return { ok: false, code: "conflict", message: error.message };
          }
          throw error;
        }
      }
      await repository.update( (current) => ({
        state: {
          ...current,
          pending: current.pending.filter((item) => item.id !== pendingId),
        },
        result: undefined,
      }));
      return { ok: true, state: await describeAll() };
    }),
    close: async () => {
      closed = true;
      if (activeRun) {
        activeRun.abort();
        await activeRun.done;
      }
    },
  };
};

export type DreamService = ReturnType<typeof createDreamService>;
