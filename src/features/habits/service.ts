import { HabitError } from "./errors.js";
import {
  dedupeLatestSignals,
  isActiveSignalPayload,
  normalizeHabitText,
  parseHabitOperationsArray,
} from "./operations.js";
import {
  HABIT_AUTO_THRESHOLD,
  HABIT_CONSOLIDATION_INTERVAL_MS,
  HABIT_SUBAGENT_PATTERN,
  HABIT_HOT_BUFFER_MAX,
  HABIT_ID_PATTERN,
  HABIT_SIGNAL_BATCH_SIZE,
  type HabitConsolidateModelInput,
  type HabitConsolidateModelOutcome,
  type HabitDomainDefinition,
  type HabitDomainOverview,
  type HabitDomainSummary,
  type HabitItem,
  type HabitOperation,
  type HabitPendingSignal,
  type HabitPromptContext,
  type HabitRepository,
  type HabitSignalPayload,
  type HabitSource,
} from "./types.js";

export type CreateHabitsServiceDeps = {
  repository: HabitRepository;
  domains: readonly HabitDomainDefinition[];
  consolidateModel: (
    input: HabitConsolidateModelInput,
    signal: AbortSignal,
  ) => Promise<HabitConsolidateModelOutcome>;
  autoThreshold?: number;
  intervalMs?: number;
  signalBatchSize?: number;
  onChanged?: (domain: string) => void;
  observeWork?: (
    sessionId: string,
    key: string,
    label: string,
  ) => ((outcome: "succeeded" | "failed", silent?: boolean) => void) | undefined;
};

const toPendingSignal = (payload: HabitSignalPayload): HabitPendingSignal => ({
  targetId: payload.targetId,
  kind: payload.kind,
  summary: payload.summary ?? "",
  reaction: payload.reaction,
  saved: payload.saved,
  comments: [...payload.comments],
  commentsTruncated: Boolean(payload.commentsTruncated),
  updatedAt: payload.updatedAt,
});

const validDomainId = (raw: string): string => {
  const domain = typeof raw === "string" ? raw.trim() : "";
  if (!HABIT_SUBAGENT_PATTERN.test(domain)) {
    throw new HabitError("INVALID_INPUT", "Invalid habit subagent identifier");
  }
  return domain;
};

const validHabitId = (raw: string): string => {
  const habitId = typeof raw === "string" ? raw.trim() : "";
  if (!HABIT_ID_PATTERN.test(habitId)) {
    throw new HabitError("INVALID_INPUT", "Invalid habit identifier");
  }
  return habitId;
};

/**
 * 通用、与领域解耦的用户行为习惯归纳服务：
 * - 维护每个领域（如 sms/news/assistant）的长期已归纳习惯列表（HabitItem[]）；
 * - 维护基于递增 seq 游标的原始反馈热缓冲（habit_signals）：未达归纳时立即注入最新样本，
 *   归纳成功提交后才原子推进游标并清理已消化信号；模型失败/取消绝不丢弃信号。
 */
export const createHabitsService = (deps: CreateHabitsServiceDeps) => {
  const autoThreshold = deps.autoThreshold ?? HABIT_AUTO_THRESHOLD;
  const intervalMs = deps.intervalMs ?? HABIT_CONSOLIDATION_INTERVAL_MS;
  const signalBatchSize = deps.signalBatchSize ?? HABIT_SIGNAL_BATCH_SIZE;

  const domainMap = new Map<string, HabitDomainDefinition>();
  for (const def of deps.domains) {
    const id = validDomainId(def.id);
    if (domainMap.has(id)) {
      throw new HabitError("INVALID_INPUT", `Duplicate habit domain: ${id}`);
    }
    domainMap.set(id, { ...def, id });
  }

  let closed = false;
  const activeRuns = new Map<string, { controller: AbortController; promise: Promise<HabitDomainOverview> }>();
  const backgroundAutoRuns = new Set<Promise<void>>();

  const ensureOpen = () => {
    if (closed) throw new HabitError("SHUTDOWN", "Habits service is closing");
  };

  const requireDomain = (rawDomain: string): HabitDomainDefinition => {
    const id = validDomainId(rawDomain);
    const def = domainMap.get(id);
    if (!def) {
      throw new HabitError("NOT_FOUND", `Unknown habit domain: ${id}`);
    }
    return def;
  };

  const getActiveUnconsolidated = async (domain: string) => {
    const records = await deps.repository.listUnconsolidatedSignals(domain);
    const deduped = dedupeLatestSignals(records);
    const active = deduped.filter((entry) => isActiveSignalPayload(entry.payload));
    return { records, active };
  };

  const notifyChanged = (domain: string) => {
    try {
      deps.onChanged?.(domain);
    } catch {
      // SSE/观察通知失败不能破坏习惯存储一致性。
    }
  };

  const getOverview = async (rawDomain: string): Promise<HabitDomainOverview> => {
    const def = requireDomain(rawDomain);
    const [habits, meta, { active }] = await Promise.all([
      deps.repository.listHabits(def.id),
      deps.repository.getDomainMeta(def.id),
      getActiveUnconsolidated(def.id),
    ]);
    const pendingSignals = [...active]
      .reverse()
      .slice(0, HABIT_HOT_BUFFER_MAX)
      .map((entry) => toPendingSignal(entry.payload));
    return {
      subagentId: def.id,
      name: def.name,
      summary: def.summary,
      running: activeRuns.has(def.id),
      habits,
      unconsolidatedCount: active.length,
      pendingSignals,
      autoThreshold,
      intervalMs,
      cursorSeq: meta.cursorSeq,
      lastRunAt: meta.lastRunAt,
      lastRunStatus: meta.lastRunStatus,
      lastRunProcessed: meta.lastRunProcessed,
      lastRunError: meta.lastRunError,
    };
  };

  const listDomainSummaries = async (): Promise<HabitDomainSummary[]> => {
    const summaries: HabitDomainSummary[] = [];
    for (const def of domainMap.values()) {
      const [habits, meta, { active }] = await Promise.all([
        deps.repository.listHabits(def.id),
        deps.repository.getDomainMeta(def.id),
        getActiveUnconsolidated(def.id),
      ]);
      summaries.push({
        subagentId: def.id,
        name: def.name,
        summary: def.summary,
        running: activeRuns.has(def.id),
        habitsCount: habits.length,
        unconsolidatedCount: active.length,
        autoThreshold,
        intervalMs,
        lastRunAt: meta.lastRunAt,
        lastRunStatus: meta.lastRunStatus,
        lastRunError: meta.lastRunError,
      });
    }
    return summaries;
  };

  const listHabits = async (rawDomain: string): Promise<HabitItem[]> => {
    const def = requireDomain(rawDomain);
    return deps.repository.listHabits(def.id);
  };

  const getPromptContext = async (rawDomain: string): Promise<HabitPromptContext> => {
    const def = requireDomain(rawDomain);
    const [habits, { active }] = await Promise.all([
      deps.repository.listHabits(def.id),
      getActiveUnconsolidated(def.id),
    ]);
    const newestFirst = [...active].reverse().slice(0, HABIT_HOT_BUFFER_MAX).map((entry) => entry.payload);
    return {
      habits,
      unconsolidatedSignals: newestFirst,
      unconsolidatedCount: active.length,
    };
  };

  const addHabit = async (rawDomain: string, rawText: string, source: HabitSource = "manual"): Promise<HabitItem> => {
    ensureOpen();
    const def = requireDomain(rawDomain);
    const text = normalizeHabitText(rawText);
    const created = await deps.repository.addHabit(def.id, text, source);
    notifyChanged(def.id);
    return created;
  };

  const updateHabit = async (rawDomain: string, rawHabitId: string, rawText: string): Promise<HabitItem> => {
    ensureOpen();
    const def = requireDomain(rawDomain);
    const habitId = validHabitId(rawHabitId);
    const text = normalizeHabitText(rawText);
    const updated = await deps.repository.updateHabit(def.id, habitId, text);
    notifyChanged(def.id);
    return updated;
  };

  const deleteHabit = async (rawDomain: string, rawHabitId: string) => {
    ensureOpen();
    const def = requireDomain(rawDomain);
    const habitId = validHabitId(rawHabitId);
    const deleted = await deps.repository.deleteHabit(def.id, habitId);
    notifyChanged(def.id);
    return deleted;
  };

  const applyOperations = async (
    rawDomain: string,
    rawOperations: readonly HabitOperation[],
    source: HabitSource = "consolidated",
    expectedUpdatedAt?: ReadonlyMap<string, string>,
  ): Promise<HabitItem[]> => {
    ensureOpen();
    const def = requireDomain(rawDomain);
    const existing = await deps.repository.listHabits(def.id);
    const existingIds = new Set(existing.map((item) => item.id));
    const operations = parseHabitOperationsArray(rawOperations, { existingIds });
    if (!operations.length) return existing;
    const updated = await deps.repository.applyOperations({
      domain: def.id,
      operations,
      source,
      expectedUpdatedAt,
    });
    notifyChanged(def.id);
    return updated;
  };

  const runConsolidationLoop = async (
    def: HabitDomainDefinition,
    signal: AbortSignal,
  ): Promise<HabitDomainOverview> => {
    const finishWork = deps.observeWork?.("main", `habits:${def.id}`, `正在整理${def.name}习惯`);
    let totalProcessed = 0;

    try {
      while (!signal.aborted && !closed) {
        const { records, active } = await getActiveUnconsolidated(def.id);
        if (!records.length) {
          break;
        }
        if (!active.length) {
          // 全是撤销/清空类事件（reaction=null, saved=false, comments=[]）：推进游标并清理，无需调模型。
          await deps.repository.commitConsolidationBatch({
            domain: def.id,
            operations: [],
            source: "consolidated",
            advanceCursorToSeq: records.at(-1)!.seq,
            processedCount: totalProcessed,
            status: totalProcessed > 0 ? "succeeded" : "skipped",
            at: new Date().toISOString(),
          });
          break;
        }

        const batch = active.slice(0, signalBatchSize);
        const cutoffSeq = batch.at(-1)!.maxSeq;
        const existingHabits = await deps.repository.listHabits(def.id);
        const expectedUpdatedAt = new Map(existingHabits.map((item) => [item.id, item.updatedAt]));
        const instructions = (await def.readInstructions?.()) ?? "";

        let outcome: HabitConsolidateModelOutcome;
        try {
          outcome = await deps.consolidateModel(
            {
              domain: def.id,
              domainName: def.name,
              domainSummary: def.summary,
              instructions,
              existingHabits,
              signals: batch.map((entry) => entry.payload),
            },
            signal,
          );
        } catch {
          outcome = {
            ok: false,
            error: signal.aborted || closed ? "CANCELLED" : "MODEL_REQUEST_FAILED",
          };
        }

        if (!outcome.ok) {
          const isCancelled = outcome.error === "CANCELLED" || signal.aborted || closed;
          await deps.repository.recordRunFailure({
            domain: def.id,
            status: isCancelled ? "cancelled" : "failed",
            error: isCancelled ? "Cancelled" : outcome.error,
            at: new Date().toISOString(),
          });
          finishWork?.("failed");
          notifyChanged(def.id);
          return getOverview(def.id);
        }

        let validatedOps: HabitOperation[];
        try {
          validatedOps = parseHabitOperationsArray(outcome.operations, {
            existingIds: new Set(existingHabits.map((item) => item.id)),
          });
        } catch {
          await deps.repository.recordRunFailure({
            domain: def.id,
            status: "failed",
            error: "INVALID_MODEL_RESULT",
            at: new Date().toISOString(),
          });
          finishWork?.("failed");
          notifyChanged(def.id);
          return getOverview(def.id);
        }

        totalProcessed += batch.length;
        await deps.repository.commitConsolidationBatch({
          domain: def.id,
          operations: validatedOps,
          source: "consolidated",
          advanceCursorToSeq: cutoffSeq,
          processedCount: totalProcessed,
          status: "succeeded",
          at: new Date().toISOString(),
          expectedUpdatedAt,
        });
      }

      if (totalProcessed === 0) {
        const currentMeta = await deps.repository.getDomainMeta(def.id);
        await deps.repository.commitConsolidationBatch({
          domain: def.id,
          operations: [],
          source: "consolidated",
          advanceCursorToSeq: currentMeta.cursorSeq,
          processedCount: 0,
          status: "skipped",
          at: new Date().toISOString(),
        });
      }

      finishWork?.("succeeded", totalProcessed === 0);
      notifyChanged(def.id);
      return getOverview(def.id);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "Habit consolidation failed";
      await deps.repository.recordRunFailure({
        domain: def.id,
        status: signal.aborted || closed ? "cancelled" : "failed",
        error: message,
        at: new Date().toISOString(),
      }).catch(() => undefined);
      finishWork?.("failed");
      notifyChanged(def.id);
      throw error;
    }
  };

  const consolidate = async (rawDomain: string, externalSignal?: AbortSignal): Promise<HabitDomainOverview> => {
    ensureOpen();
    const def = requireDomain(rawDomain);
    if (activeRuns.has(def.id)) {
      throw new HabitError("BUSY", `Habit consolidation is already running for domain: ${def.id}`);
    }
    const controller = new AbortController();
    const abortListener = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", abortListener, { once: true });
    }
    const runPromise = runConsolidationLoop(def, controller.signal).finally(() => {
      activeRuns.delete(def.id);
      externalSignal?.removeEventListener("abort", abortListener);
    });
    activeRuns.set(def.id, { controller, promise: runPromise });
    return runPromise;
  };

  const recordSignal = async (
    rawDomain: string,
    targetId: string,
    payload: HabitSignalPayload,
  ): Promise<void> => {
    if (closed) return;
    const def = requireDomain(rawDomain);
    await deps.repository.appendSignal(def.id, targetId, payload);
    notifyChanged(def.id);
    if (closed || activeRuns.has(def.id)) return;
    const { active } = await getActiveUnconsolidated(def.id);
    if (active.length >= autoThreshold && !closed && !activeRuns.has(def.id)) {
      const task = consolidate(def.id)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          backgroundAutoRuns.delete(task);
        });
      backgroundAutoRuns.add(task);
    }
  };

  const runDue = async (externalSignal?: AbortSignal): Promise<void> => {
    if (closed) return;
    for (const def of domainMap.values()) {
      if (closed || externalSignal?.aborted) return;
      if (activeRuns.has(def.id)) continue;
      const { active } = await getActiveUnconsolidated(def.id);
      if (!active.length) continue;
      const meta = await deps.repository.getDomainMeta(def.id);
      const anchor = meta.lastRunAt ?? active[0]!.createdAt;
      const anchorMs = Date.parse(anchor);
      if (!Number.isNaN(anchorMs) && Date.now() - anchorMs < intervalMs) {
        continue;
      }
      await consolidate(def.id, externalSignal).catch(() => undefined);
    }
  };

  const close = async (): Promise<void> => {
    closed = true;
    for (const run of activeRuns.values()) {
      run.controller.abort();
    }
    await Promise.allSettled([
      ...[...activeRuns.values()].map((run) => run.promise),
      ...backgroundAutoRuns,
    ]);
  };

  return {
    listDomains: () => [...domainMap.keys()],
    listDomainSummaries,
    hasDomain: (domain: string) => domainMap.has(domain),
    getOverview,
    listHabits,
    getPromptContext,
    addHabit,
    updateHabit,
    deleteHabit,
    applyOperations,
    recordSignal,
    consolidate,
    runDue,
    close,
  };
};

export type HabitsService = ReturnType<typeof createHabitsService>;
