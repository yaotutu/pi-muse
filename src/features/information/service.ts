import { randomUUID } from "node:crypto";
import { isWorkspaceText } from "../../shared/workspace-text.js";
import { projectFeedback } from "../messages/service.js";
import type { MessageFeedbackRepository } from "../messages/types.js";
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
  InformationState,
  InformationStatus,
} from "./types.js";

export const MAX_INFORMATION_ITEMS_PER_BATCH = 20;
export const MAX_ARCHIVE_ITEMS_PER_BATCH = 25;
export const MAX_INFORMATION_BATCH_CHARS = 60_000;

const MAX_BRIEFING_CANDIDATES = 80;
const MAX_FEEDBACK_EXAMPLES = 10;
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
  status?: string;
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
      ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
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
  feedback: MessageFeedbackRepository;
  runModel: (input: InformationModelInput, signal: AbortSignal) => Promise<InformationModelOutcome>;
  synthesizeBriefing?: (input: InformationBriefingInput, signal: AbortSignal) => Promise<InformationBriefingOutcome>;
  observeWork?: (
    sessionId: string,
    key: string,
    label: string,
  ) => ((outcome: "succeeded" | "failed", silent?: boolean) => void) | undefined;
};

/**
 * 短信/信息后台领域服务（Clean Break 版）。
 *
 * 严格分离两条路径，且共享用户指令（workspace/domains/sms/INSTRUCTIONS.md）、
 * 自学习敏感度画像（learnedNotes）与主对话反馈闭环：
 * 1. 日常实时单周期（queue = "realtime"）：接入 -> 到期/触发 -> 取批 + 画像/指令/反馈 ->
 *    一次受限模型判定 -> 落库 decisions/learnedNotes/pending publications -> 投递主对话。
 * 2. 历史批量归档（queue = "archive"）：独立入口导入，不触发实时调度；逐批演化 learnedNotes，
 *    当归档队列全部清零（pending === 0 && failed === 0）时最多生成 1 条 <=1200 字简报发主对话。
 */
export const createInformationService = (deps: CreateInformationServiceDeps) => {
  const domainId = deps.domainId ?? "sms";
  let closed = false;
  let pauseDepth = 0;
  let activeRunPromise: Promise<unknown> | undefined;
  let activeArchiveLoop: Promise<void> | undefined;
  let activeController: AbortController | undefined;

  const isPaused = () => pauseDepth > 0;
  const ensureOpen = () => {
    if (closed) throw new InformationError("SHUTDOWN", "Information service is closing");
  };

  const feedbackExamples = async (
    state: InformationState,
    piSessionId: string,
  ): Promise<InformationFeedbackExample[]> => {
    const candidates = [...state.runs]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
      .flatMap((run) =>
        run.publications
          .filter((pub) => pub.status === "published" && pub.receipt?.piSessionId === piSessionId)
          .map((pub) => ({ run, pub })),
      );
    if (!candidates.length) return [];
    const document = await deps.feedback.read("main", piSessionId);
    const itemById = new Map(state.items.map((item) => [item.id, item]));
    const examples: InformationFeedbackExample[] = [];

    for (const { run, pub } of candidates) {
      const feedback = projectFeedback(document, pub.receipt!.messageId);
      if (!feedback.reaction && !feedback.saved && !feedback.comments.length) continue;
      const comments = feedback.comments.slice(0, MAX_FEEDBACK_COMMENTS);
      examples.push({
        runId: run.id,
        notificationId: pub.notificationId,
        text: clipText(pub.text, FEEDBACK_TEXT_LENGTH).text,
        reaction: feedback.reaction,
        saved: feedback.saved,
        comments: comments.map((comment) => clipText(comment.text, FEEDBACK_TEXT_LENGTH).text),
        commentsTruncated:
          feedback.comments.length > MAX_FEEDBACK_COMMENTS ||
          feedback.comments.some((comment) => comment.text.length > FEEDBACK_TEXT_LENGTH),
        items: pub.itemIds.slice(0, MAX_FEEDBACK_ITEMS).map((itemId) => {
          const item = itemById.get(itemId);
          return {
            id: itemId,
            source: item?.source ?? "unknown",
            ...(item?.title ? { title: clipText(item.title, FEEDBACK_TEXT_LENGTH).text } : {}),
            content: clipText(item?.content ?? "", FEEDBACK_CONTENT_LENGTH).text,
            contentTruncated: (item?.content.length ?? 0) > FEEDBACK_CONTENT_LENGTH,
          };
        }),
      });
      if (examples.length >= MAX_FEEDBACK_EXAMPLES) break;
    }
    return examples;
  };

  const loadPromptContext = async (state: InformationState): Promise<{
    instructions: string;
    learnedNotes: string;
    feedbackExamples: InformationFeedbackExample[];
  }> => {
    const [instructions, retained] = await Promise.all([
      (deps.instructions.readResolved ?? deps.instructions.read)(),
      deps.retainMain(),
    ]);
    const learnedNotes = state.preferences.learnedNotes;
    if (!retained) {
      return { instructions, learnedNotes, feedbackExamples: [] };
    }
    try {
      const examples = await feedbackExamples(state, retained.conversation.piSessionId());
      return { instructions, learnedNotes, feedbackExamples: examples };
    } finally {
      retained.release();
    }
  };

  const getSettings = async (): Promise<InformationSettings> => {
    const { settings } = await deps.repository.read();
    return { enabled: settings.enabled, batchWindowSeconds: settings.batchWindowSeconds };
  };

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
    return deps.repository.update((state) => ({
      state: {
        ...state,
        settings: { enabled: settings.enabled, batchWindowSeconds: settings.batchWindowSeconds },
      },
      result: { enabled: settings.enabled, batchWindowSeconds: settings.batchWindowSeconds },
    }));
  };

  const getPreferences = async (): Promise<InformationPreferencesView> => {
    const [instructions, state] = await Promise.all([deps.instructions.read(), deps.repository.read()]);
    const retained = await deps.retainMain();
    if (!retained) {
      return {
        instructions,
        learnedNotes: state.preferences.learnedNotes,
        feedbackExamples: [],
      };
    }
    try {
      return {
        instructions,
        learnedNotes: state.preferences.learnedNotes,
        feedbackExamples: await feedbackExamples(state, retained.conversation.piSessionId()),
      };
    } finally {
      retained.release();
    }
  };

  const savePreferences = async (input: { instructions: string }): Promise<InformationPreferencesView> => {
    ensureOpen();
    const instructions = normalizeInstructions(input.instructions);
    await deps.instructions.write(instructions);
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
    return deps.repository.update((state) => {
      if (queue === "realtime" && !state.settings.enabled) {
        throw new InformationError("DISABLED", "Information background is disabled");
      }
      const existingByKey = new Map(state.items.map((item) => [`${item.source}\0${item.externalId}`, item]));
      const accepted: InformationItem[] = [];
      const responseItems: InformationItem[] = [];
      const seenResponseIds = new Set<string>();
      let skippedCount = 0;

      for (const input of inputs) {
        const key = `${input.source}\0${input.externalId}`;
        const existing = existingByKey.get(key);
        if (existing) {
          const timeMismatch =
            input.receivedAt !== undefined &&
            Date.parse(existing.receivedAt) !== Date.parse(input.receivedAt);
          if (
            existing.content !== input.content ||
            (existing.title ?? undefined) !== (input.title ?? undefined) ||
            timeMismatch
          ) {
            throw new InformationError(
              "CONFLICT",
              `Conflicting content for existing source=${input.source} externalId=${input.externalId}`,
            );
          }
          skippedCount++;
          if (!seenResponseIds.has(existing.id)) {
            seenResponseIds.add(existing.id);
            responseItems.push(existing);
          }
          continue;
        }
        const created: InformationItem = {
          id: `info_${randomUUID()}`,
          queue,
          source: input.source,
          externalId: input.externalId,
          ...(input.title !== undefined ? { title: input.title } : {}),
          content: input.content,
          receivedAt: input.receivedAt ?? now,
          acceptedAt: now,
          status: "pending",
        };
        existingByKey.set(key, created);
        seenResponseIds.add(created.id);
        accepted.push(created);
        responseItems.push(created);
      }

      if (!accepted.length) {
        return {
          result: {
            items: queue === "archive" ? [] : responseItems,
            skippedCount,
          },
        };
      }
      return {
        state: {
          ...state,
          items: [...state.items, ...accepted],
        },
        result: {
          items: queue === "archive" ? accepted : responseItems,
          skippedCount,
        },
      };
    });
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
    const state = await deps.repository.read();
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const scope = `${options.queue ?? "all"}:${options.status ?? "all"}`;
    let after: Cursor | undefined;
    if (options.cursor !== undefined) {
      const decoded = decodeCursor(options.cursor);
      if (!decoded || decoded.scope !== scope) {
        throw new InformationError("INVALID_INPUT", "Invalid items cursor");
      }
      after = decoded;
    }
    const ordered = [...state.items]
      .filter((item) => (!options.status || item.status === options.status) && (!options.queue || item.queue === options.queue))
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.id.localeCompare(a.id));
    const startIndex = after
      ? ordered.findIndex((item) =>
          item.acceptedAt.localeCompare(after!.at) < 0 ||
          (item.acceptedAt === after!.at && item.id.localeCompare(after!.id) < 0))
      : 0;
    const slice = startIndex === -1 ? [] : ordered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex !== -1 && startIndex + limit < ordered.length;
    const last = slice.at(-1);
    return {
      items: slice,
      ...(hasMore && last ? { nextCursor: encodeCursor({ id: last.id, at: last.acceptedAt, scope }) } : {}),
    };
  };

  const getItem = async (rawItemId: string) => {
    const itemId = validId(rawItemId, "itemId");
    const state = await deps.repository.read();
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new InformationError("NOT_FOUND", `Unknown information item: ${itemId}`);
    const runs = [...state.runs]
      .filter((run) => run.itemIds.includes(itemId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { item, runs };
  };

  const listRuns = async (options: {
    status?: InformationRunStatus;
    kind?: InformationRunKind;
    limit?: number;
    cursor?: string;
  }) => {
    const state = await deps.repository.read();
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const scope = `${options.kind ?? "all"}:${options.status ?? "all"}`;
    let after: Cursor | undefined;
    if (options.cursor !== undefined) {
      const decoded = decodeCursor(options.cursor);
      if (!decoded || decoded.scope !== scope) {
        throw new InformationError("INVALID_INPUT", "Invalid runs cursor");
      }
      after = decoded;
    }
    const ordered = [...state.runs]
      .filter((run) => (!options.status || run.status === options.status) && (!options.kind || run.kind === options.kind))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    const startIndex = after
      ? ordered.findIndex((run) =>
          run.startedAt.localeCompare(after!.at) < 0 ||
          (run.startedAt === after!.at && run.id.localeCompare(after!.id) < 0))
      : 0;
    const slice = startIndex === -1 ? [] : ordered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex !== -1 && startIndex + limit < ordered.length;
    const last = slice.at(-1);
    return {
      runs: slice,
      ...(hasMore && last ? { nextCursor: encodeCursor({ id: last.id, at: last.startedAt, scope }) } : {}),
    };
  };

  const getRun = async (rawRunId: string) => {
    const runId = validId(rawRunId, "runId");
    const state = await deps.repository.read();
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new InformationError("NOT_FOUND", `Unknown information run: ${runId}`);
    const itemById = new Map(state.items.map((item) => [item.id, item]));
    const items = run.itemIds.map((id) => itemById.get(id)).filter((item): item is InformationItem => Boolean(item));
    return { run, items };
  };

  const getStatus = async (): Promise<InformationStatus> => {
    const state = await deps.repository.read();
    let pendingCount = 0;
    let failedCount = 0;
    let archivePendingCount = 0;
    let archiveProcessedCount = 0;
    let archiveFailedCount = 0;

    for (const item of state.items) {
      if (item.queue === "realtime") {
        if (item.status === "pending") pendingCount++;
        else if (item.status === "failed") failedCount++;
      } else {
        if (item.status === "pending") archivePendingCount++;
        else if (item.status === "processed") archiveProcessedCount++;
        else if (item.status === "failed") archiveFailedCount++;
      }
    }

    const latestRun = [...state.runs].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
    )[0];
    let lastError: string | null = null;
    if (latestRun?.status === "failed") {
      lastError = latestRun.model?.error ?? "MODEL_REQUEST_FAILED";
    } else if (latestRun) {
      const failedPub = latestRun.publications.find((pub) => pub.status === "failed" && pub.error);
      if (failedPub?.error) lastError = failedPub.error;
    }

    return {
      enabled: state.settings.enabled,
      batchWindowSeconds: state.settings.batchWindowSeconds,
      running: Boolean(activeRunPromise || activeArchiveLoop || state.runs.some((run) => run.status === "running")),
      pendingCount,
      failedCount,
      archive: {
        running: Boolean(activeArchiveLoop),
        pendingCount: archivePendingCount,
        processedCount: archiveProcessedCount,
        failedCount: archiveFailedCount,
      },
      lastRunAt: latestRun?.finishedAt ?? latestRun?.startedAt ?? null,
      lastError,
    };
  };

  const claimBatch = async (
    queue: InformationQueue,
    options: { forceRealtime: boolean },
  ): Promise<{ run: InformationRun; items: InformationItem[]; state: InformationState } | null> => {
    const maxItems = queue === "realtime" ? MAX_INFORMATION_ITEMS_PER_BATCH : MAX_ARCHIVE_ITEMS_PER_BATCH;
    return deps.repository.update((state) => {
      if (queue === "realtime" && !options.forceRealtime && !state.settings.enabled) {
        return { result: null };
      }
      const pending = state.items.filter((item) => item.queue === queue && item.status === "pending");
      if (!pending.length) return { result: null };
      if (queue === "realtime" && !options.forceRealtime) {
        const dueAt = Date.parse(pending[0]!.acceptedAt) + state.settings.batchWindowSeconds * 1000;
        if (!Number.isNaN(dueAt) && Date.now() < dueAt) return { result: null };
      }

      const selected: InformationItem[] = [];
      let chars = 0;
      for (const item of pending) {
        if (selected.length >= maxItems) break;
        if (selected.length > 0 && chars + item.content.length > MAX_INFORMATION_BATCH_CHARS) break;
        selected.push(item);
        chars += item.content.length;
      }
      const now = new Date().toISOString();
      const runId = `inforun_${randomUUID()}`;
      const selectedIds = new Set(selected.map((item) => item.id));
      const run: InformationRun = {
        id: runId,
        kind: queue,
        status: "running",
        createdAt: now,
        startedAt: now,
        itemIds: selected.map((item) => item.id),
        publications: [],
      };
      const nextState: InformationState = {
        ...state,
        items: state.items.map((item) =>
          selectedIds.has(item.id) ? { ...item, status: "processing" as const, runId } : item),
        runs: [...state.runs, run],
      };
      return { state: nextState, result: { run, items: selected, state: nextState } };
    });
  };

  const markRunFailed = async (runId: string, itemIds: readonly string[], errorMessage: string) => {
    const finishedAt = new Date().toISOString();
    const idSet = new Set(itemIds);
    return deps.repository.update((state) => {
      let updatedRun!: InformationRun;
      const nextRuns = state.runs.map((run) => {
        if (run.id !== runId) return run;
        updatedRun = {
          ...run,
          status: "failed",
          finishedAt,
          model: { status: "failed", error: errorMessage },
        };
        return updatedRun;
      });
      return {
        state: {
          ...state,
          items: state.items.map((item) => (idSet.has(item.id) ? { ...item, status: "failed" as const } : item)),
          runs: nextRuns,
        },
        result: updatedRun,
      };
    });
  };

  const markRunCancelled = async (runId: string, itemIds: readonly string[]) => {
    const finishedAt = new Date().toISOString();
    const idSet = new Set(itemIds);
    return deps.repository.update((state) => {
      let updatedRun!: InformationRun;
      const nextRuns = state.runs.map((run) => {
        if (run.id !== runId) return run;
        updatedRun = {
          ...run,
          status: "cancelled",
          finishedAt,
        };
        return updatedRun;
      });
      return {
        state: {
          ...state,
          items: state.items.map((item) => {
            if (!idSet.has(item.id) || item.status !== "processing") return item;
            const { runId: _drop, ...rest } = item;
            return { ...rest, status: "pending" as const };
          }),
          runs: nextRuns,
        },
        result: updatedRun,
      };
    });
  };

  /**
   * 投递指定 run 上挂起的 pending notifications 到主对话。
   * 两阶段持久化：先以 pending 状态落库，每条投递成功/失败后立即回写 receipt 或 error。
   */
  const deliverPendingPublications = async (
    runId: string,
    signal: AbortSignal,
  ): Promise<InformationRun> => {
    const snapshot = await deps.repository.read();
    const currentRun = snapshot.runs.find((run) => run.id === runId);
    if (!currentRun) throw new InformationError("NOT_FOUND", `Run missing during delivery: ${runId}`);

    const retained = await deps.retainMain();
    if (!retained) {
      const finishedAt = new Date().toISOString();
      return deps.repository.update((state) => {
        let finalRun!: InformationRun;
        const runs = state.runs.map((run) => {
          if (run.id !== runId) return run;
          finalRun = {
            ...run,
            status: "completed",
            finishedAt,
            publications: run.publications.map((pub) =>
              pub.status === "pending" ? { ...pub, status: "failed" as const, error: "Main session unavailable" } : pub),
          };
          return finalRun;
        });
        return { state: { ...state, runs }, result: finalRun };
      });
    }

    try {
      for (const publication of currentRun.publications) {
        if (publication.status !== "pending") continue;
        const latest = await deps.repository.read();
        const aborted = signal.aborted || isPaused() || closed;
        const realtimeDisabled = currentRun.kind === "realtime" && !latest.settings.enabled;
        if (aborted || realtimeDisabled) {
          const reason = realtimeDisabled ? "Information background disabled" : "Cancelled before notification delivery";
          await deps.repository.update((state) => ({
            state: {
              ...state,
              runs: state.runs.map((run) =>
                run.id !== runId
                  ? run
                  : {
                      ...run,
                      publications: run.publications.map((pub) =>
                        pub.status === "pending" ? { ...pub, status: "failed" as const, error: reason } : pub),
                    }),
            },
            result: undefined,
          }));
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

        await deps.repository.update((state) => ({
          state: {
            ...state,
            runs: state.runs.map((run) => {
              if (run.id !== runId) return run;
              return {
                ...run,
                publications: run.publications.map((pub) => {
                  if (pub.notificationId !== publication.notificationId) return pub;
                  if (receipt) {
                    return {
                      ...pub,
                      status: "published" as const,
                      receipt,
                    };
                  }
                  return {
                    ...pub,
                    status: "failed" as const,
                    error: errorText ?? "Notification failed",
                  };
                }),
              };
            }),
          },
          result: undefined,
        }));
      }
    } finally {
      retained.release();
    }

    const finishedAt = new Date().toISOString();
    return deps.repository.update((state) => {
      let finalRun!: InformationRun;
      const runs = state.runs.map((run) => {
        if (run.id !== runId) return run;
        finalRun = {
          ...run,
          status: "completed",
          finishedAt,
          publications: run.publications.map((pub) =>
            pub.status === "pending" ? { ...pub, status: "failed" as const, error: "Delivery interrupted" } : pub),
        };
        return finalRun;
      });
      return { state: { ...state, runs }, result: finalRun };
    });
  };

  /** 执行单次批次：realtime 直接生成并投递通知；archive 仅更新决策与长期画像。 */
  const executeSingleBatch = async (
    claimed: { run: InformationRun; items: InformationItem[]; state: InformationState },
  ): Promise<InformationRun> => {
    const isRealtime = claimed.run.kind === "realtime";
    const finishWork = deps.observeWork?.(
      "main",
      isRealtime ? "information" : "information-archive",
      isRealtime ? "正在判断收件信息" : "正在归纳历史短信画像",
    );
    const controller = new AbortController();
    activeController = controller;
    if (isPaused() || closed) controller.abort();

    try {
      let context: Awaited<ReturnType<typeof loadPromptContext>>;
      try {
        context = await loadPromptContext(claimed.state);
      } catch (error) {
        if (controller.signal.aborted || isPaused() || closed) {
          const cancelled = await markRunCancelled(claimed.run.id, claimed.run.itemIds);
          finishWork?.("failed");
          return cancelled;
        }
        await markRunFailed(claimed.run.id, claimed.run.itemIds, sanitizeError(error));
        finishWork?.("failed");
        throw error;
      }
      if (controller.signal.aborted || isPaused() || closed) {
        const cancelled = await markRunCancelled(claimed.run.id, claimed.run.itemIds);
        finishWork?.("failed");
        return cancelled;
      }

      let outcome: InformationModelOutcome;
      try {
        outcome = await deps.runModel({
          runId: claimed.run.id,
          sessionId: "main",
          kind: claimed.run.kind,
          instructions: context.instructions,
          learnedNotes: context.learnedNotes,
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
          const cancelled = await markRunCancelled(claimed.run.id, claimed.run.itemIds);
          finishWork?.("failed");
          return cancelled;
        }
        const failed = await markRunFailed(claimed.run.id, claimed.run.itemIds, outcome.error);
        finishWork?.("failed");
        return failed;
      }

      let parsed: InformationModelResult;
      try {
        parsed = parseInformationResult(outcome.result, claimed.run.itemIds, {
          allowNotifications: isRealtime,
          allowEmptyNotifications: !isRealtime,
          requireLearnedNotes: !isRealtime,
        });
      } catch {
        const failed = await markRunFailed(claimed.run.id, claimed.run.itemIds, "INVALID_MODEL_RESULT");
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

      const claimedIdSet = new Set(claimed.run.itemIds);
      const updatedRun = await deps.repository.update((state) => {
        let savedRun!: InformationRun;
        const runs = state.runs.map((run) => {
          if (run.id !== claimed.run.id) return run;
          savedRun = {
            ...run,
            status: pendingPublications.length ? "running" : "completed",
            ...(pendingPublications.length ? {} : { finishedAt: now }),
            model: { status: "succeeded" },
            decisions: parsed.decisions,
            publications: pendingPublications,
          };
          return savedRun;
        });
        return {
          state: {
            ...state,
            preferences: parsed.learnedNotes !== undefined
              ? { ...state.preferences, learnedNotes: parsed.learnedNotes }
              : state.preferences,
            items: state.items.map((item) =>
              claimedIdSet.has(item.id) ? { ...item, status: "processed" as const } : item),
            runs,
          },
          result: savedRun,
        };
      });

      if (!pendingPublications.length) {
        finishWork?.("succeeded", parsed.decisions.every((d) => d.decision === "silent"));
        return updatedRun;
      }

      const delivered = await deliverPendingPublications(claimed.run.id, controller.signal);
      finishWork?.("succeeded", false);
      return delivered;
    } finally {
      if (activeController === controller) activeController = undefined;
    }
  };

  /** 当历史归档队列全部处理完成（pending === 0 && failed === 0）时，最多发出 1 条 <= 1200 字总结简报。 */
  const maybePublishArchiveBriefing = async (lastRunId: string): Promise<boolean> => {
    if (!deps.synthesizeBriefing) return false;
    const state = await deps.repository.read();
    const archiveItems = state.items.filter((item) => item.queue === "archive");
    if (!archiveItems.length) return false;
    if (archiveItems.some((item) => item.status === "pending" || item.status === "processing" || item.status === "failed")) {
      return false;
    }

    const archiveRuns = state.runs
      .filter((run) => run.kind === "archive" && run.status === "completed")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
    // 只收集最近一次已发简报之后的这一波归档批次，避免重复汇总早期已汇报批次。
    const waveRuns: InformationRun[] = [];
    for (let i = archiveRuns.length - 1; i >= 0; i--) {
      const run = archiveRuns[i]!;
      if (run.publications.length > 0) break;
      waveRuns.unshift(run);
    }
    if (!waveRuns.length) return false;

    const itemById = new Map(archiveItems.map((item) => [item.id, item]));
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
        const item = itemById.get(decision.itemId);
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
      const context = await loadPromptContext(state);
      if (controller.signal.aborted) return false;

      const outcome = await deps.synthesizeBriefing({
        runId: lastRunId,
        sessionId: "main",
        instructions: context.instructions,
        learnedNotes: context.learnedNotes,
        feedbackExamples: context.feedbackExamples,
        totalScanned,
        silentCount,
        batchCount: waveRuns.length,
        candidates,
      }, controller.signal);

      if (!outcome.ok) {
        const failedPub: InformationPublication = {
          notificationId: `info-notification-${lastRunId}-0`,
          text: "(archive briefing failed)",
          itemIds: [],
          status: "failed",
          error: outcome.error,
        };
        await deps.repository.update((current) => ({
          state: {
            ...current,
            runs: current.runs.map((run) =>
              run.id === lastRunId ? { ...run, publications: [failedPub] } : run),
          },
          result: undefined,
        }));
        return false;
      }

      const candidateIds = candidates.map((candidate) => candidate.itemId);
      const parsed = parseInformationBriefingResult(
        { text: outcome.text, itemIds: outcome.itemIds },
        candidateIds,
      );
      const pendingPub: InformationPublication = {
        notificationId: `info-notification-${lastRunId}-0`,
        text: parsed.text.slice(0, ARCHIVE_BRIEFING_MAX_LENGTH),
        itemIds: parsed.itemIds,
        status: "pending",
      };
      await deps.repository.update((current) => ({
        state: {
          ...current,
          runs: current.runs.map((run) =>
            run.id === lastRunId ? { ...run, publications: [pendingPub] } : run),
        },
        result: undefined,
      }));
      const delivered = await deliverPendingPublications(lastRunId, controller.signal);
      return delivered.publications.some((pub) => pub.status === "published");
    } catch (error) {
      const failedPub: InformationPublication = {
        notificationId: `info-notification-${lastRunId}-0`,
        text: "(archive briefing failed)",
        itemIds: [],
        status: "failed",
        error: sanitizeError(error),
      };
      await deps.repository.update((current) => ({
        state: {
          ...current,
          runs: current.runs.map((run) =>
            run.id === lastRunId ? { ...run, publications: [failedPub] } : run),
        },
        result: undefined,
      }));
      return false;
    } finally {
      if (activeController === controller) activeController = undefined;
    }
  };

  /** 手动立即触发一次实时待处理队列分析（queue = "realtime"）。 */
  const runNow = async (): Promise<{ run: InformationRun; items: InformationItem[] }> => {
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
      const claimed = await claimBatch("realtime", { forceRealtime: true });
      if (!claimed) {
        throw new InformationError("NO_PENDING", "No pending realtime information items");
      }
      const run = await executeSingleBatch(claimed);
      const itemMap = new Map(claimed.items.map((item) => [item.id, item]));
      const latest = await deps.repository.read();
      const finalItems = run.itemIds
        .map((id) => latest.items.find((item) => item.id === id) ?? itemMap.get(id))
        .filter((item): item is InformationItem => Boolean(item));
      return { run, items: finalItems };
    })();
    activeRunPromise = runPromise;
    try {
      return await runPromise;
    } finally {
      if (activeRunPromise === runPromise) activeRunPromise = undefined;
    }
  };

  /** 执行历史归档批量消化，逐批提炼 learnedNotes，队列清零后发至多 1 条总览简报。 */
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
      await deps.repository.update((state) => ({
        state: {
          ...state,
          items: state.items.map((item) => {
            if (item.queue !== "archive" || item.status !== "failed") return item;
            const { runId: _drop, ...rest } = item;
            return { ...rest, status: "pending" as const };
          }),
        },
        result: undefined,
      }));
    }

    const initialState = await deps.repository.read();
    const initialPending = initialState.items.filter(
      (item) => item.queue === "archive" && item.status === "pending",
    ).length;
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

    const endState = await deps.repository.read();
    const remainingPendingCount = endState.items.filter(
      (item) => item.queue === "archive" && item.status === "pending",
    ).length;
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
