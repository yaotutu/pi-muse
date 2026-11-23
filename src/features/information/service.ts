import type { UserFeedbackSnapshot } from "../../shared/feedback.js";
import type {
  ResolvedWorkspaceDocument,
  WorkspaceIncludeDiagnostic,
} from "../../shared/workspace-includes.js";
import { isWorkspaceText } from "../../shared/workspace-text.js";
import type { HabitsService } from "../habits/service.js";
import type { HabitPromptContext, HabitSignalPayload } from "../habits/types.js";
import { InformationError } from "./errors.js";
import {
  ARCHIVE_BRIEFING_MAX_LENGTH,
  parseInformationBriefingResult,
  parseInformationResult,
} from "./result.js";
import type {
  InformationArchiveCandidate,
  InformationArchiveRunResult,
  InformationBriefingInput,
  InformationBriefingOutcome,
  InformationFeedbackExample,
  InformationInputItem,
  InformationItem,
  InformationItemStatus,
  InformationModelInput,
  InformationModelOutcome,
  InformationModelResult,
  InformationPreferencesView,
  InformationPublication,
  InformationPublicationReceipt,
  InformationQueue,
  InformationRepository,
  InformationRun,
  InformationRunKind,
  InformationRunStatus,
  InformationSettings,
  InformationStatus,
} from "./types.js";

export const MAX_INFORMATION_ITEMS_PER_BATCH = 20;
export const MAX_ARCHIVE_ITEMS_PER_BATCH = 25;
export const MAX_INFORMATION_BATCH_CHARS = 60_000;

const MAX_BRIEFING_CANDIDATES = 80;
const MAX_FEEDBACK_EXAMPLES = 20;
const MAX_FEEDBACK_ITEMS = 20;
const MAX_FEEDBACK_COMMENTS = 5;
const FEEDBACK_TEXT_LENGTH = 1000;
const FEEDBACK_CONTENT_LENGTH = 2000;
const PREFERENCES_INSTRUCTIONS_MAX_LENGTH = 20_000;
const CONTENT_EXCERPT_MAX = 400;

const SOURCE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const validId = (raw: string, label: string): string => {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!ID_PATTERN.test(value)) {
    throw new InformationError("INVALID_INPUT", `${label} must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}`);
  }
  return value;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Cursor = {
  id: string;
  at: string;
  scope?: string;
};

const encodeCursor = (value: Cursor) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeCursor = (value: string): Cursor | undefined => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!isPlainRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.at !== "string") {
      return undefined;
    }
    return {
      id: parsed.id,
      at: parsed.at,
      ...(typeof parsed.scope === "string" ? { scope: parsed.scope } : {}),
    };
  } catch {
    return undefined;
  }
};

const sanitizeError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "Information processing failed";
};

const clipText = (text: string, maxLength: number) =>
  text.length > maxLength ? { text: text.slice(0, maxLength), truncated: true } : { text, truncated: false };

const normalizeInstructions = (instructions: string): string => {
  if (typeof instructions !== "string" || !isWorkspaceText(instructions)) {
    throw new InformationError("INVALID_INPUT", "Invalid preferences instructions");
  }
  if (instructions.length > PREFERENCES_INSTRUCTIONS_MAX_LENGTH) {
    throw new InformationError(
      "INVALID_INPUT",
      `Preferences instructions must be at most ${PREFERENCES_INSTRUCTIONS_MAX_LENGTH} characters`,
    );
  }
  return instructions;
};

const validateInputItem = (input: InformationInputItem): void => {
  if (typeof input.source !== "string" || !SOURCE_PATTERN.test(input.source)) {
    throw new InformationError("INVALID_INPUT", "source must be an ASCII identifier");
  }
  if (
    typeof input.externalId !== "string" ||
    !input.externalId.trim() ||
    input.externalId.trim().length > 256 ||
    !isWorkspaceText(input.externalId)
  ) {
    throw new InformationError("INVALID_INPUT", "Invalid externalId");
  }
  if (
    typeof input.content !== "string" ||
    !input.content.trim() ||
    input.content.length > 20_000 ||
    !isWorkspaceText(input.content)
  ) {
    throw new InformationError("INVALID_INPUT", "Invalid item content");
  }
  if (input.title !== undefined) {
    if (
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 500 ||
      !isWorkspaceText(input.title)
    ) {
      throw new InformationError("INVALID_INPUT", "Invalid item title");
    }
  }
  if (input.receivedAt !== undefined) {
    const parsedTime = Date.parse(input.receivedAt);
    if (typeof input.receivedAt !== "string" || Number.isNaN(parsedTime)) {
      throw new InformationError("INVALID_INPUT", "Invalid item receivedAt");
    }
  }
};

export type CreateInformationServiceDeps = {
  domainId?: string;
  repository: InformationRepository;
  instructions: {
    read: () => Promise<string>;
    readResolved?: () => Promise<string>;
    inspect?: () => Promise<ResolvedWorkspaceDocument>;
    write: (content: string) => Promise<void>;
  };
  retainMain: () => Promise<{
    conversation: {
      piSessionId: () => string;
      notify: (
        text: string,
        id: string,
        options?: { signal?: AbortSignal; domainId?: string },
      ) => Promise<InformationPublicationReceipt>;
    };
    release: () => void;
  } | undefined>;
  habits?: Pick<HabitsService, "getPromptContext" | "applyOperations">;
  onChanged?: (scope: "items" | "runs" | "preferences" | "settings") => void;
  runModel: (input: InformationModelInput, signal: AbortSignal) => Promise<InformationModelOutcome>;
  synthesizeBriefing?: (input: InformationBriefingInput, signal: AbortSignal) => Promise<InformationBriefingOutcome>;
  observeWork?: (
    sessionId: string,
    key: string,
    label: string,
  ) => ((outcome: "succeeded" | "failed", silent?: boolean) => void) | undefined;
};

const emptyHabitPromptContext = (): HabitPromptContext => ({
  habits: [],
  unconsolidatedSignals: [],
  unconsolidatedCount: 0,
});

const signalsToFeedbackExamples = (signals: readonly HabitSignalPayload[]): InformationFeedbackExample[] =>
  signals
    .filter((sig) => sig.kind === "sms_notification")
    .slice(0, MAX_FEEDBACK_EXAMPLES)
    .map((sig) => ({
      runId: sig.meta?.runId ?? "",
      notificationId: sig.targetId,
      text: sig.summary ?? "",
      reaction: sig.reaction,
      saved: sig.saved,
      comments: sig.comments,
      commentsTruncated: Boolean(sig.commentsTruncated),
      items: (sig.items ?? []).map((item) => ({
        id: item.id,
        source: item.source,
        ...(item.title !== undefined ? { title: item.title } : {}),
        content: item.content,
        contentTruncated: Boolean(item.contentTruncated),
      })),
    }));

/**
 * 短信/信息后台领域服务（Clean Break v4）：
 * - 存储完全下沉为精确 SQL 查询与原子事务，支持条目直接投影 decision/reason 与有界历史裁剪。
 * - 用户偏好对称收敛为 instructions + includes 诊断 + habits + unconsolidatedFeedbackCount。
 * - 日常实时通道支持 retryFailed 重跑失败条目，状态变化发出 domain_updated 轻量失效事件。
 */
export const createInformationService = (deps: CreateInformationServiceDeps) => {
  const domainId = deps.domainId ?? "sms";
  const habitsPort: Pick<HabitsService, "getPromptContext" | "applyOperations"> = deps.habits ?? {
    getPromptContext: async () => emptyHabitPromptContext(),
    applyOperations: async () => [],
  };
  let closed = false;
  let pauseDepth = 0;
  let activeRunPromise: Promise<unknown> | undefined;
  let activeArchiveLoop: Promise<void> | undefined;
  let activeController: AbortController | undefined;

  const isPaused = () => pauseDepth > 0;
  const ensureOpen = () => {
    if (closed) throw new InformationError("SHUTDOWN", "Information service is closing");
  };
  const notifyChanged = (scope: "items" | "runs" | "preferences" | "settings") => {
    try {
      deps.onChanged?.(scope);
    } catch {
      // SSE/观察通知失败不中断核心存储流。
    }
  };

  /** 将主对话中的短信通知交互反馈投影为通用 HabitSignalPayload（含撤销清空状态，便于从热缓冲剔除）。 */
  const buildHabitSignal = async (
    notificationId: string,
    feedback: UserFeedbackSnapshot,
  ): Promise<HabitSignalPayload | undefined> => {
    const context = await deps.repository.getNotificationContext(notificationId);
    if (!context) return undefined;
    const itemById = new Map(context.items.map((item) => [item.id, item]));
    const recentComments = feedback.comments.slice(-MAX_FEEDBACK_COMMENTS);
    return {
      targetId: context.publication.notificationId,
      kind: "sms_notification",
      summary: clipText(context.publication.text, FEEDBACK_TEXT_LENGTH).text,
      reaction: feedback.reaction,
      saved: feedback.saved,
      comments: recentComments.map((comment) => clipText(comment.text, FEEDBACK_TEXT_LENGTH).text),
      commentsTruncated:
        feedback.comments.length > MAX_FEEDBACK_COMMENTS ||
        recentComments.some((comment) => comment.text.length > FEEDBACK_TEXT_LENGTH),
      items: context.publication.itemIds.slice(0, MAX_FEEDBACK_ITEMS).map((itemId) => {
        const item = itemById.get(itemId);
        const clipped = clipText(item?.content ?? "", FEEDBACK_CONTENT_LENGTH);
        return {
          id: itemId,
          source: item?.source ?? "unknown",
          ...(item?.title ? { title: clipText(item.title, FEEDBACK_TEXT_LENGTH).text } : {}),
          content: clipped.text,
          contentTruncated: clipped.truncated,
        };
      }),
      meta: { runId: context.runId },
      updatedAt: new Date().toISOString(),
    };
  };

  const loadPromptContext = async () => {
    const [instructions, habitCtx] = await Promise.all([
      (deps.instructions.readResolved ?? deps.instructions.read)(),
      habitsPort.getPromptContext(domainId),
    ]);
    return {
      instructions,
      habits: habitCtx.habits,
      feedbackExamples: signalsToFeedbackExamples(habitCtx.unconsolidatedSignals),
    };
  };

  const readInstructionsWithIncludes = async (): Promise<{
    instructions: string;
    includes: WorkspaceIncludeDiagnostic[];
  }> => {
    if (deps.instructions.inspect) {
      const inspected = await deps.instructions.inspect();
      return { instructions: inspected.raw, includes: inspected.includes };
    }
    return { instructions: await deps.instructions.read(), includes: [] };
  };

  const getSettings = (): Promise<InformationSettings> => deps.repository.getSettings();

  const saveSettings = async (settings: InformationSettings): Promise<InformationSettings> => {
    ensureOpen();
    if (
      typeof settings.enabled !== "boolean" ||
      !Number.isInteger(settings.batchWindowSeconds) ||
      settings.batchWindowSeconds < 0 ||
      settings.batchWindowSeconds > 3600
    ) {
      throw new InformationError("INVALID_INPUT", "Invalid information settings");
    }
    const saved = await deps.repository.saveSettings(settings);
    notifyChanged("settings");
    return saved;
  };

  const getPreferences = async (): Promise<InformationPreferencesView> => {
    const [{ instructions, includes }, habitCtx] = await Promise.all([
      readInstructionsWithIncludes(),
      habitsPort.getPromptContext(domainId),
    ]);
    return {
      instructions,
      includes,
      habits: habitCtx.habits,
      unconsolidatedFeedbackCount: habitCtx.unconsolidatedCount,
    };
  };

  const savePreferences = async (input: { instructions: string }): Promise<InformationPreferencesView> => {
    ensureOpen();
    const instructions = normalizeInstructions(input.instructions);
    await deps.instructions.write(instructions);
    notifyChanged("preferences");
    return getPreferences();
  };

  const ingestToQueue = async (
    inputs: readonly InformationInputItem[],
    queue: InformationQueue,
  ): Promise<{ items: InformationItem[]; skippedCount: number }> => {
    ensureOpen();
    if (isPaused() && queue === "realtime") {
      throw new InformationError("SESSION_PAUSED", "Information background is paused");
    }
    for (const input of inputs) validateInputItem(input);
    if (!inputs.length) return { items: [], skippedCount: 0 };

    const now = new Date().toISOString();
    const ingested = await deps.repository.ingestItems(queue, inputs, now);
    if (ingested.accepted.length > 0) {
      notifyChanged("items");
    }
    return {
      items: queue === "archive" ? ingested.accepted : ingested.responseItems,
      skippedCount: ingested.skippedCount,
    };
  };

  /** 日常实时短信入库，进入实时调度队列。 */
  const ingest = async (inputs: readonly InformationInputItem[]): Promise<InformationItem[]> =>
    (await ingestToQueue(inputs, "realtime")).items;

  /** 历史短信批量导入，仅写入归档队列，不触发日常实时调度。 */
  const ingestArchive = async (
    inputs: readonly InformationInputItem[],
  ): Promise<{ items: InformationItem[]; skippedCount: number }> => ingestToQueue(inputs, "archive");

  const listItems = async (options: {
    status?: InformationItemStatus;
    queue?: InformationQueue;
    limit?: number;
    cursor?: string;
  }) => {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const scope = `${options.queue ?? "all"}:${options.status ?? "all"}`;
    let after: { at: string; id: string } | undefined;
    if (options.cursor !== undefined) {
      const decoded = decodeCursor(options.cursor);
      if (!decoded || decoded.scope !== scope) {
        throw new InformationError("INVALID_INPUT", "Invalid items cursor");
      }
      after = { at: decoded.at, id: decoded.id };
    }
    const { items, hasMore } = await deps.repository.listItems({
      queue: options.queue,
      status: options.status,
      limit,
      after,
    });
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last ? { nextCursor: encodeCursor({ id: last.id, at: last.acceptedAt, scope }) } : {}),
    };
  };

  const getItem = async (rawItemId: string) => {
    const itemId = validId(rawItemId, "itemId");
    const detail = await deps.repository.getItem(itemId);
    if (!detail) throw new InformationError("NOT_FOUND", `Unknown information item: ${itemId}`);
    return detail;
  };

  const listRuns = async (options: {
    status?: InformationRunStatus;
    kind?: InformationRunKind;
    limit?: number;
    cursor?: string;
  }) => {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const scope = `${options.kind ?? "all"}:${options.status ?? "all"}`;
    let after: { at: string; id: string } | undefined;
    if (options.cursor !== undefined) {
      const decoded = decodeCursor(options.cursor);
      if (!decoded || decoded.scope !== scope) {
        throw new InformationError("INVALID_INPUT", "Invalid runs cursor");
      }
      after = { at: decoded.at, id: decoded.id };
    }
    const { runs, hasMore } = await deps.repository.listRuns({
      kind: options.kind,
      status: options.status,
      limit,
      after,
    });
    const last = runs.at(-1);
    return {
      runs,
      ...(hasMore && last ? { nextCursor: encodeCursor({ id: last.id, at: last.startedAt, scope }) } : {}),
    };
  };

  const getRun = async (rawRunId: string) => {
    const runId = validId(rawRunId, "runId");
    const detail = await deps.repository.getRun(runId);
    if (!detail) throw new InformationError("NOT_FOUND", `Unknown information run: ${runId}`);
    return detail;
  };

  const getStatus = async (): Promise<InformationStatus> => {
    const summary = await deps.repository.getStatusSummary();
    return {
      enabled: summary.enabled,
      batchWindowSeconds: summary.batchWindowSeconds,
      running: Boolean(activeRunPromise || activeArchiveLoop || summary.hasRunningRow),
      pendingCount: summary.pendingCount,
      failedCount: summary.failedCount,
      archive: {
        running: Boolean(activeArchiveLoop),
        pendingCount: summary.archivePendingCount,
        processedCount: summary.archiveProcessedCount,
        failedCount: summary.archiveFailedCount,
      },
      lastRunAt: summary.lastRunAt,
      lastError: summary.lastError,
    };
  };

  const claimBatch = (queue: InformationQueue, options: { forceRealtime: boolean }) =>
    deps.repository.claimBatch(queue, {
      forceRealtime: options.forceRealtime,
      maxItems: queue === "realtime" ? MAX_INFORMATION_ITEMS_PER_BATCH : MAX_ARCHIVE_ITEMS_PER_BATCH,
      maxChars: MAX_INFORMATION_BATCH_CHARS,
      now: new Date().toISOString(),
    });

  /**
   * 投递指定 run 上挂起的 pending notifications 到主对话。
   * 两阶段持久化：先以 pending 状态落库，每条投递成功/失败后立即回写 receipt 或 error。
   */
  const deliverPendingPublications = async (
    runId: string,
    signal: AbortSignal,
  ): Promise<InformationRun> => {
    const initialDetail = await deps.repository.getRun(runId);
    if (!initialDetail) throw new InformationError("NOT_FOUND", `Run missing during delivery: ${runId}`);
    const currentRun = initialDetail.run;

    const retained = await deps.retainMain();
    if (!retained) {
      return deps.repository.finalizeDelivery(runId, new Date().toISOString(), "Main session unavailable");
    }

    try {
      for (const publication of currentRun.publications) {
        if (publication.status !== "pending") continue;
        const latestSettings = await getSettings();
        const aborted = signal.aborted || isPaused() || closed;
        const realtimeDisabled = currentRun.kind === "realtime" && !latestSettings.enabled;
        if (aborted || realtimeDisabled) {
          const reason = realtimeDisabled ? "Information background disabled" : "Cancelled before notification delivery";
          await deps.repository.failPendingPublications(runId, reason);
          break;
        }

        let receipt: InformationPublicationReceipt | undefined;
        let errorText: string | undefined;
        try {
          receipt = await retained.conversation.notify(publication.text, publication.notificationId, {
            signal,
            domainId,
          });
        } catch (error) {
          errorText = sanitizeError(error);
        }

        await deps.repository.updatePublication(
          runId,
          publication.notificationId,
          receipt
            ? { status: "published", receipt }
            : { status: "failed", error: errorText ?? "Notification failed" },
        );
      }
    } finally {
      retained.release();
    }

    return deps.repository.finalizeDelivery(runId, new Date().toISOString(), "Delivery interrupted");
  };

  /** 执行单次批次：realtime 直接生成并投递通知；archive 仅更新决策与增量习惯操作。 */
  const executeSingleBatch = async (
    claimed: { run: InformationRun; items: InformationItem[] },
  ): Promise<InformationRun> => {
    const isRealtime = claimed.run.kind === "realtime";
    const finishWork = deps.observeWork?.(
      "main",
      isRealtime ? "information" : "information-archive",
      isRealtime ? "正在判断收件信息" : "正在归纳历史短信习惯",
    );
    const controller = new AbortController();
    activeController = controller;
    if (isPaused() || closed) controller.abort();

    try {
      let context: Awaited<ReturnType<typeof loadPromptContext>>;
      try {
        context = await loadPromptContext();
      } catch (error) {
        if (controller.signal.aborted || isPaused() || closed) {
          const cancelled = await deps.repository.revertClaimedRun(
            claimed.run.id,
            claimed.run.itemIds,
            new Date().toISOString(),
          );
          notifyChanged("items");
          notifyChanged("runs");
          finishWork?.("failed");
          return cancelled;
        }
        await deps.repository.markRunFailed(
          claimed.run.id,
          claimed.run.itemIds,
          sanitizeError(error),
          new Date().toISOString(),
        );
        notifyChanged("items");
        notifyChanged("runs");
        finishWork?.("failed");
        throw error;
      }
      if (controller.signal.aborted || isPaused() || closed) {
        const cancelled = await deps.repository.revertClaimedRun(
          claimed.run.id,
          claimed.run.itemIds,
          new Date().toISOString(),
        );
        notifyChanged("items");
        notifyChanged("runs");
        finishWork?.("failed");
        return cancelled;
      }

      const existingHabitIds = new Set(context.habits.map((habit) => habit.id));
      const expectedUpdatedAt = new Map(context.habits.map((habit) => [habit.id, habit.updatedAt]));

      let outcome: InformationModelOutcome;
      try {
        outcome = await deps.runModel({
          runId: claimed.run.id,
          sessionId: "main",
          kind: claimed.run.kind,
          instructions: context.instructions,
          habits: context.habits,
          feedbackExamples: context.feedbackExamples,
          items: claimed.items.map((item) => ({
            id: item.id,
            source: item.source,
            externalId: item.externalId,
            ...(item.title !== undefined ? { title: item.title } : {}),
            content: item.content,
            receivedAt: item.receivedAt,
            acceptedAt: item.acceptedAt,
          })),
        }, controller.signal);
      } catch {
        outcome = { ok: false, error: controller.signal.aborted ? "CANCELLED" : "MODEL_REQUEST_FAILED" };
      }

      if (!outcome.ok) {
        if (outcome.error === "CANCELLED" || controller.signal.aborted) {
          const cancelled = await deps.repository.revertClaimedRun(
            claimed.run.id,
            claimed.run.itemIds,
            new Date().toISOString(),
          );
          notifyChanged("items");
          notifyChanged("runs");
          finishWork?.("failed");
          return cancelled;
        }
        const failed = await deps.repository.markRunFailed(
          claimed.run.id,
          claimed.run.itemIds,
          outcome.error,
          new Date().toISOString(),
        );
        notifyChanged("items");
        notifyChanged("runs");
        finishWork?.("failed");
        return failed;
      }

      let parsed: InformationModelResult;
      try {
        parsed = parseInformationResult(outcome.result, claimed.run.itemIds, {
          allowNotifications: isRealtime,
          allowEmptyNotifications: !isRealtime,
          allowHabitOperations: !isRealtime,
          existingHabitIds,
        });
      } catch {
        const failed = await deps.repository.markRunFailed(
          claimed.run.id,
          claimed.run.itemIds,
          "INVALID_MODEL_RESULT",
          new Date().toISOString(),
        );
        notifyChanged("items");
        notifyChanged("runs");
        finishWork?.("failed");
        return failed;
      }

      const now = new Date().toISOString();
      const pendingPublications: InformationPublication[] = parsed.notifications.map((draft, index) => ({
        notificationId: `info-notification-${claimed.run.id}-${index}`,
        text: draft.text,
        itemIds: draft.itemIds,
        status: "pending",
      }));

      const updatedRun = await deps.repository.completeModelRound({
        runId: claimed.run.id,
        itemIds: claimed.run.itemIds,
        decisions: parsed.decisions,
        publications: pendingPublications,
        finishedAt: now,
      });

      if (!isRealtime && parsed.habitOperations?.length) {
        await habitsPort.applyOperations(domainId, parsed.habitOperations, "consolidated", expectedUpdatedAt);
      }

      notifyChanged("items");
      notifyChanged("runs");

      if (!pendingPublications.length) {
        if (isRealtime) {
          await deps.repository.pruneHistory().catch(() => undefined);
        }
        finishWork?.("succeeded", parsed.decisions.every((d) => d.decision === "silent"));
        return updatedRun;
      }

      const delivered = await deliverPendingPublications(claimed.run.id, controller.signal);
      if (isRealtime) {
        await deps.repository.pruneHistory().catch(() => undefined);
      }
      notifyChanged("runs");
      finishWork?.("succeeded", false);
      return delivered;
    } finally {
      if (activeController === controller) activeController = undefined;
    }
  };

  /** 当历史归档队列全部处理完成（pending === 0 && failed === 0）时，最多发出 1 条 <= 1200 字总结简报。 */
  const maybePublishArchiveBriefing = async (lastRunId: string): Promise<boolean> => {
    if (!deps.synthesizeBriefing) return false;
    const wave = await deps.repository.getArchiveBriefingWave();
    if (!wave) return false;

    const { itemsById, waveRuns } = wave;
    let totalScanned = 0;
    let silentCount = 0;
    const candidates: InformationArchiveCandidate[] = [];
    for (const run of waveRuns) {
      for (const decision of run.decisions ?? []) {
        totalScanned++;
        if (decision.decision === "silent") {
          silentCount++;
          continue;
        }
        if (candidates.length >= MAX_BRIEFING_CANDIDATES) continue;
        const item = itemsById.get(decision.itemId);
        if (!item) continue;
        candidates.push({
          itemId: item.id,
          source: item.source,
          ...(item.title !== undefined ? { title: item.title } : {}),
          contentExcerpt: clipText(item.content, CONTENT_EXCERPT_MAX).text,
          receivedAt: item.receivedAt,
          reason: decision.reason,
        });
      }
    }

    const controller = new AbortController();
    activeController = controller;
    if (isPaused() || closed) controller.abort();
    try {
      const context = await loadPromptContext();
      if (controller.signal.aborted) return false;

      const outcome = await deps.synthesizeBriefing({
        runId: lastRunId,
        sessionId: "main",
        instructions: context.instructions,
        habits: context.habits,
        feedbackExamples: context.feedbackExamples,
        totalScanned,
        silentCount,
        batchCount: waveRuns.length,
        candidates,
      }, controller.signal);

      if (!outcome.ok) {
        await deps.repository.setRunPublications(lastRunId, [{
          notificationId: `info-notification-${lastRunId}-0`,
          text: "(archive briefing failed)",
          itemIds: [],
          status: "failed",
          error: outcome.error,
        }]);
        notifyChanged("runs");
        return false;
      }

      const candidateIds = candidates.map((candidate) => candidate.itemId);
      const parsed = parseInformationBriefingResult(
        { text: outcome.text, itemIds: outcome.itemIds },
        candidateIds,
      );
      await deps.repository.setRunPublications(lastRunId, [{
        notificationId: `info-notification-${lastRunId}-0`,
        text: parsed.text.slice(0, ARCHIVE_BRIEFING_MAX_LENGTH),
        itemIds: parsed.itemIds,
        status: "pending",
      }]);
      const delivered = await deliverPendingPublications(lastRunId, controller.signal);
      notifyChanged("runs");
      return delivered.publications.some((pub) => pub.status === "published");
    } catch (error) {
      await deps.repository.setRunPublications(lastRunId, [{
        notificationId: `info-notification-${lastRunId}-0`,
        text: "(archive briefing failed)",
        itemIds: [],
        status: "failed",
        error: sanitizeError(error),
      }]);
      notifyChanged("runs");
      return false;
    } finally {
      if (activeController === controller) activeController = undefined;
    }
  };

  /** 手动立即触发一次实时待处理队列分析（queue = "realtime"）；支持 retryFailed 重置失败条目并立即重跑。 */
  const runNow = async (options?: { retryFailed?: boolean }): Promise<{ run: InformationRun; items: InformationItem[] }> => {
    ensureOpen();
    if (isPaused()) throw new InformationError("SESSION_PAUSED", "Information background is paused");
    if (activeRunPromise || activeArchiveLoop) {
      throw new InformationError("BUSY", "Information processing is already running");
    }
    const runPromise = (async () => {
      const currentSettings = await getSettings();
      if (!currentSettings.enabled) {
        throw new InformationError("DISABLED", "Information background is disabled");
      }
      if (options?.retryFailed) {
        const resetCount = await deps.repository.requeueFailed("realtime");
        if (resetCount > 0) notifyChanged("items");
      }
      const claimed = await claimBatch("realtime", { forceRealtime: true });
      if (!claimed) {
        throw new InformationError("NO_PENDING", "No pending realtime information items");
      }
      const run = await executeSingleBatch(claimed);
      const detail = await deps.repository.getRun(run.id);
      return {
        run: detail?.run ?? run,
        items: detail?.items ?? claimed.items,
      };
    })();
    activeRunPromise = runPromise;
    try {
      return await runPromise;
    } finally {
      if (activeRunPromise === runPromise) activeRunPromise = undefined;
    }
  };

  /** 执行历史归档批量消化，逐批向通用习惯引擎提交增量变更，队列清零后发至多 1 条总览简报。 */
  const runArchive = async (options?: {
    background?: boolean;
    retryFailed?: boolean;
  }): Promise<InformationArchiveRunResult> => {
    ensureOpen();
    if (isPaused()) throw new InformationError("SESSION_PAUSED", "Information background is paused");
    if (activeRunPromise || activeArchiveLoop) {
      throw new InformationError("BUSY", "Information processing is already running");
    }

    if (options?.retryFailed) {
      const resetCount = await deps.repository.requeueFailed("archive");
      if (resetCount > 0) notifyChanged("items");
    }

    const initialPending = (await deps.repository.getStatusSummary()).archivePendingCount;
    if (initialPending === 0) {
      throw new InformationError("NO_PENDING", "No pending archive items");
    }

    let runsCount = 0;
    let processedCount = 0;
    let failedCount = 0;
    let briefingPublished = false;
    let lastRunId: string | undefined;

    const drainLoop = async () => {
      while (!closed && !isPaused()) {
        const claimed = await claimBatch("archive", { forceRealtime: true });
        if (!claimed) break;
        runsCount++;
        lastRunId = claimed.run.id;
        const result = await executeSingleBatch(claimed);
        if (result.status === "completed") {
          processedCount += claimed.items.length;
        } else if (result.status === "failed") {
          failedCount += claimed.items.length;
        }
      }
      if (!closed && !isPaused() && lastRunId) {
        briefingPublished = await maybePublishArchiveBriefing(lastRunId);
      }
      await deps.repository.pruneHistory().catch(() => undefined);
    };

    if (options?.background) {
      const loop = drainLoop().catch(() => undefined).finally(() => {
        if (activeArchiveLoop === loop) activeArchiveLoop = undefined;
      });
      activeArchiveLoop = loop;
      return {
        status: "started",
        runsCount: 0,
        processedCount: 0,
        failedCount: 0,
        remainingPendingCount: initialPending,
        briefingPublished: false,
      };
    }

    const loop = drainLoop().finally(() => {
      if (activeArchiveLoop === loop) activeArchiveLoop = undefined;
    });
    activeArchiveLoop = loop;
    await loop;

    const remainingPendingCount = (await deps.repository.getStatusSummary()).archivePendingCount;
    return {
      status: remainingPendingCount === 0 && failedCount === 0 ? "completed" : "partial",
      runsCount,
      processedCount,
      failedCount,
      remainingPendingCount,
      briefingPublished,
    };
  };

  /** 领域子 Agent 只读查询入口。 */
  const query = async (input: {
    action: "overview" | "items" | "item" | "runs" | "run";
    itemId?: string;
    runId?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  }) => {
    switch (input.action) {
      case "overview": {
        const [status, preferences] = await Promise.all([getStatus(), getPreferences()]);
        return { status, preferences };
      }
      case "items":
        return listItems({
          status: input.status as InformationItemStatus | undefined,
          limit: input.limit,
          cursor: input.cursor,
        });
      case "item":
        return getItem(input.itemId ?? "");
      case "runs":
        return listRuns({
          status: input.status as InformationRunStatus | undefined,
          limit: input.limit,
          cursor: input.cursor,
        });
      case "run":
        return getRun(input.runId ?? "");
    }
  };

  const nextDue = async (): Promise<boolean> => {
    if (closed || isPaused() || activeRunPromise || activeArchiveLoop) return false;
    return deps.repository.nextRealtimeDue();
  };

  const runDue = async (): Promise<boolean> => {
    if (closed || isPaused() || activeRunPromise || activeArchiveLoop) return false;
    let ran = false;
    const work = (async () => {
      const claimed = await claimBatch("realtime", { forceRealtime: false });
      if (!claimed) return;
      ran = true;
      await executeSingleBatch(claimed);
    })();
    activeRunPromise = work;
    try {
      await work;
      return ran;
    } finally {
      if (activeRunPromise === work) activeRunPromise = undefined;
    }
  };

  const pause = () => {
    pauseDepth++;
    if (pauseDepth === 1) activeController?.abort();
    const stopped = Promise.allSettled([activeRunPromise, activeArchiveLoop]).then(() => undefined);
    let resumed = false;
    return {
      stopped,
      resume: () => {
        if (resumed) return;
        resumed = true;
        pauseDepth = Math.max(0, pauseDepth - 1);
      },
    };
  };

  const close = async (): Promise<void> => {
    closed = true;
    activeController?.abort();
    await Promise.allSettled([activeRunPromise, activeArchiveLoop]);
  };

  return {
    getSettings,
    saveSettings,
    getPreferences,
    savePreferences,
    buildHabitSignal,
    ingest,
    ingestArchive,
    listItems,
    getItem,
    getStatus,
    runNow,
    runArchive,
    listRuns,
    getRun,
    query,
    nextDue,
    runDue,
    pause,
    close,
  };
};

export type InformationService = ReturnType<typeof createInformationService>;
