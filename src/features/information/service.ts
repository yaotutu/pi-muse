import { randomUUID } from "node:crypto";
import { projectFeedback } from "../messages/service.js";
import type { MessageFeedbackRepository } from "../messages/types.js";
import { InformationError } from "./errors.js";
import type { ObserveWork } from "../workspace/session-presence.js";
import { INITIAL_BRIEFING_MAX_LENGTH, parseInformationResult } from "./result.js";
import type {
  InformationBriefingCandidate,
  InformationBriefingInput,
  InformationBriefingResult,
  InformationBriefingUpdate,
  InformationDecision,
  InformationFeedbackExample,
  InformationInputItem,
  InformationItem,
  InformationItemStatus,
  InformationModelInput,
  InformationModelResult,
  InformationPreferences,
  InformationRepository,
  InformationRun,
  InformationSettings,
  InformationState,
} from "./types.js";

export const MAX_INFORMATION_ITEMS_PER_BATCH = 20;
export const MAX_INITIAL_INFORMATION_ITEMS_PER_BATCH = 30;
export const MAX_INFORMATION_BATCH_CHARS = 60_000;
const BULK_IMPORT_HOLD_MS = 60_000;
const MAX_BRIEFING_CANDIDATES = 80;
const MAX_BRIEFING_UPDATES = 20;
const MAX_FEEDBACK_EXAMPLES = 10;
const MAX_FEEDBACK_ITEMS = 20;
const MAX_FEEDBACK_COMMENTS = 5;
const FEEDBACK_TEXT_LENGTH = 1000;
const FEEDBACK_CONTENT_LENGTH = 2000;
const ITEM_STATUSES = new Set<InformationItemStatus>(["pending", "processing", "processed", "failed"]);
const RUN_STATUSES = new Set<InformationRun["status"]>(["running", "completed", "failed", "cancelled"]);

type ActiveSlot = {
  controller: AbortController;
  done: Promise<void>;
  release: () => void;
};

type PipelinePause = {
  stopped: Promise<void>;
  resume: () => void;
};

type Cursor = { id: string; at: string; status?: string };
type NewsCursor = { publishedAt: string; id: string; view: "recommended" | "all"; savedOnly: boolean };

export type InformationServiceDependencies = {
  observeWork?: ObserveWork;
  domainId?: string;
  repository: InformationRepository;
  retainMain: () => Promise<{
    conversation: {
      piSessionId: () => string;
      notify: (
        text: string,
        id: string,
        options?: { signal?: AbortSignal; domainId?: string },
      ) => Promise<{ piSessionId: string; messageId: string }>;
    };
    release: () => void;
  } | undefined>;
  feedback: MessageFeedbackRepository;
  runModel: (input: InformationModelInput, signal: AbortSignal) => Promise<InformationModelResult>;
  synthesizeBriefing?: (input: InformationBriefingInput, signal: AbortSignal) => Promise<InformationBriefingResult>;
};

const now = () => new Date().toISOString();
const keyOf = (source: string, externalId: string) => `${source}\0${externalId}`;
const sortedItems = (items: readonly InformationItem[]) =>
  [...items].sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) || b.id.localeCompare(a.id));
const sortedRuns = (runs: readonly InformationRun[]) =>
  [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
const encodeCursor = (value: Cursor) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const decodeCursor = (value: string): Cursor | undefined => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.id !== "string" || typeof parsed.at !== "string") return undefined;
    if (parsed.status !== undefined && typeof parsed.status !== "string") return undefined;
    return { id: parsed.id, at: parsed.at, ...(parsed.status === undefined ? {} : { status: parsed.status }) };
  } catch {
    return undefined;
  }
};
const decodeNewsCursor = (value: string): NewsCursor | undefined => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<NewsCursor>;
    if (typeof parsed.publishedAt !== "string" || typeof parsed.id !== "string") return undefined;
    if (parsed.view !== "recommended" && parsed.view !== "all") return undefined;
    if (typeof parsed.savedOnly !== "boolean") return undefined;
    return { publishedAt: parsed.publishedAt, id: parsed.id, view: parsed.view, savedOnly: parsed.savedOnly };
  } catch {
    return undefined;
  }
};
const validId = (value: string | undefined, label: string): string => {
  if (!value || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InformationError("INVALID_INPUT", `Invalid information ${label}`);
  }
  return value;
};
const sameNewInput = (left: InformationInputItem, right: InformationInputItem) =>
  left.content === right.content &&
  (left.title ?? null) === (right.title ?? null) &&
  (left.receivedAt ?? null) === (right.receivedAt ?? null) &&
  (left.metadata?.sourceId ?? null) === (right.metadata?.sourceId ?? null) &&
  (left.metadata?.sourceTitle ?? null) === (right.metadata?.sourceTitle ?? null) &&
  (left.metadata?.url ?? null) === (right.metadata?.url ?? null);
const matchesStoredInput = (stored: InformationItem, input: InformationInputItem) =>
  stored.content === input.content &&
  (stored.title ?? null) === (input.title ?? null) &&
  (input.receivedAt === undefined || input.receivedAt === stored.receivedAt) &&
  (stored.metadata?.sourceId ?? null) === (input.metadata?.sourceId ?? null) &&
  (stored.metadata?.sourceTitle ?? null) === (input.metadata?.sourceTitle ?? null) &&
  (stored.metadata?.url ?? null) === (input.metadata?.url ?? null);

/** 信息域服务：持久化输入与执行事实，但执行轮本身完全交给 pi SDK runner。 */
export const createInformationService = (deps: InformationServiceDependencies) => {
  let active: ActiveSlot | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let pauses = 0;
  let bulkImportHoldUntil = 0;

  // 全局执行槽必须在第一个 await 前同步占住，手动/自动争用不会重复 claim。
  const reserveSlot = (): ActiveSlot => {
    if (closed) throw new InformationError("SHUTDOWN", "Information processing is closing");
    if (active) throw new InformationError("BUSY", "Another information run is active");
    const controller = new AbortController();
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const slot: ActiveSlot = {
      controller,
      done,
      release: () => {
        if (active === slot) active = undefined;
        release();
      },
    };
    active = slot;
    return slot;
  };
  const requireOpen = () => {
    if (closed) throw new InformationError("SHUTDOWN", "Information processing is closing");
  };
  const isPaused = () => pauses > 0;
  const page = <T extends { id: string }>(
    values: readonly T[],
    cursorAt: (value: T) => string,
    limit: number,
    cursor?: string,
    scope?: string,
  ) => {
    let after: Cursor | undefined;
    if (cursor) {
      after = decodeCursor(cursor);
      if (!after || after.status !== scope) {
        throw new InformationError("INVALID_INPUT", "Invalid information cursor");
      }
    }
    const filtered = after
      ? values.filter((value) => {
        const at = cursorAt(value);
        return at < after!.at || (at === after!.at && value.id < after!.id);
      })
      : [...values];
    const selected = filtered.slice(0, limit);
    // 游标指向本页最后一条已返回记录，避免用未返回项造成下一页跳过。
    const last = selected.at(-1);
    return {
      values: selected,
      nextCursor: selected.length === limit && last
        ? encodeCursor({ id: last.id, at: cursorAt(last), ...(scope ? { status: scope } : {}) })
        : undefined,
    };
  };

  const getSettings = async () => {
    const settings = (await deps.repository.read()).settings;
    return { enabled: settings.enabled, batchWindowSeconds: settings.batchWindowSeconds };
  };
  const saveSettings = async (
    settings: Pick<InformationSettings, "enabled" | "batchWindowSeconds">,
  ) => {
    requireOpen();
    return deps.repository.update((state) => ({
      state: {
        ...state,
        settings: {
          ...state.settings,
          enabled: settings.enabled,
          batchWindowSeconds: settings.batchWindowSeconds,
        },
      },
      result: { enabled: settings.enabled, batchWindowSeconds: settings.batchWindowSeconds },
    }), { allowCreate: true });
  };

  const configure = async (settings: InformationSettings) => {
    requireOpen();
    return deps.repository.update((state) => ({
      state: { ...state, settings },
      result: settings,
    }), { allowCreate: true });
  };

  const feedbackExamples = async (
    state: InformationState,
    piSessionId: string,
  ): Promise<InformationFeedbackExample[]> => {
    const candidates = sortedRuns(state.runs).flatMap((run) =>
      run.publications
        .filter((publication) => publication.status === "published" && publication.receipt?.piSessionId === piSessionId)
        .map((publication) => ({ run, publication })),
    );
    if (!candidates.length) return [];
    // 反馈文件缺失是合法空反馈；损坏/I/O 失败必须暴露，不能伪装成无偏好。
    const document = await deps.feedback.read("main", piSessionId);
    const examples: InformationFeedbackExample[] = [];
    for (const { run, publication } of candidates) {
      const feedback = projectFeedback(document, publication.receipt!.messageId);
      if (!feedback.reaction && !feedback.comments.length) continue;
      const comments = feedback.comments.slice(0, MAX_FEEDBACK_COMMENTS);
      const itemById = new Map(state.items.map((item) => [item.id, item]));
      examples.push({
        runId: run.id,
        notificationId: publication.notificationId,
        text: publication.text.slice(0, FEEDBACK_TEXT_LENGTH),
        reaction: feedback.reaction,
        comments: comments.map((comment) => comment.text.slice(0, FEEDBACK_TEXT_LENGTH)),
        commentsTruncated: feedback.comments.length > MAX_FEEDBACK_COMMENTS ||
          feedback.comments.some((comment) => comment.text.length > FEEDBACK_TEXT_LENGTH),
        items: publication.itemIds.slice(0, MAX_FEEDBACK_ITEMS).map((itemId) => {
          const item = itemById.get(itemId);
          return {
            id: itemId,
            source: item?.source ?? "unknown",
            ...(item?.title ? { title: item.title.slice(0, FEEDBACK_TEXT_LENGTH) } : {}),
            content: (item?.content ?? "").slice(0, FEEDBACK_CONTENT_LENGTH),
            contentTruncated: (item?.content.length ?? 0) > FEEDBACK_CONTENT_LENGTH,
          };
        }),
      });
      if (examples.length >= MAX_FEEDBACK_EXAMPLES) break;
    }
    return examples;
  };

  const articleFeedbackExamples = (state: InformationState) => {
    const itemById = new Map(state.items.map((item) => [item.id, item]));
    return state.articleFeedback
      .filter((feedback) => feedback.reaction !== null || feedback.saved || feedback.comments.length > 0)
      .slice(-20)
      .reverse()
      .flatMap((feedback) => {
        const item = itemById.get(feedback.itemId);
        if (!item) return [];
        return [{
          id: item.id,
          ...(item.title ? { title: item.title.slice(0, FEEDBACK_TEXT_LENGTH) } : {}),
          content: item.content.slice(0, FEEDBACK_CONTENT_LENGTH),
          contentTruncated: item.content.length > FEEDBACK_CONTENT_LENGTH,
          reaction: feedback.reaction,
          saved: feedback.saved,
          comments: feedback.comments.slice(-MAX_FEEDBACK_COMMENTS).map((comment) =>
            comment.text.slice(0, FEEDBACK_TEXT_LENGTH)),
        }];
      });
  };
  const getPreferences = async () => {
    const state = await deps.repository.read();
    const learnedNotes = state.preferences.learnedNotes;
    if (state.settings.mode === "recommendations") {
      return { notes: state.preferences.notes, learnedNotes, feedbackExamples: [] };
    }
    const notes = state.preferences.notes;
    const retained = await deps.retainMain();
    if (!retained) return { notes, learnedNotes, feedbackExamples: [] };
    try {
      return {
        notes,
        learnedNotes,
        feedbackExamples: await feedbackExamples(state, retained.conversation.piSessionId()),
      };
    } finally {
      retained.release();
    }
  };
  const getNewsPreferences = async () => {
    const preferences = (await deps.repository.read()).preferences;
    return { notes: preferences.notes, learnedNotes: preferences.learnedNotes };
  };
  const savePreferences = async (preferences: Pick<InformationPreferences, "notes">) => {
    requireOpen();
    return deps.repository.update((state) => ({
      state: { ...state, preferences: { notes: preferences.notes, learnedNotes: state.preferences.learnedNotes } },
      result: { notes: preferences.notes },
    }), { allowCreate: true });
  };

  const emptyFeedbackFor = (itemId: string) => ({ itemId, reaction: null, saved: false, comments: [] });
  const updateArticle = async <T>(
    itemId: string,
    change: (feedback: NonNullable<InformationState["articleFeedback"][number]>) => T,
  ) => deps.repository.update((state) => {
    if (!state.items.some((item) => item.id === itemId)) {
      throw new InformationError("NOT_FOUND", "Information item not found");
    }
    const existing = state.articleFeedback.find((feedback) => feedback.itemId === itemId);
    const feedback = structuredClone(existing ?? emptyFeedbackFor(itemId));
    const result = change(feedback);
    return {
      state: {
        ...state,
        // Array order is recency order: touching an old article must move it to the end.
        articleFeedback: [
          ...state.articleFeedback.filter((candidate) => candidate.itemId !== itemId),
          feedback,
        ],
      },
      result,
    };
  });

  const setArticleReaction = (rawItemId: string, reaction: "like" | "dislike" | null) => {
    requireOpen();
    return updateArticle(validId(rawItemId, "itemId"), (feedback) => {
      feedback.reaction = reaction;
      return feedback;
    });
  };

  const setArticleSaved = (rawItemId: string, saved: boolean) => {
    requireOpen();
    return updateArticle(validId(rawItemId, "itemId"), (feedback) => {
      feedback.saved = saved;
      return feedback;
    });
  };

  const addArticleComment = (rawItemId: string, text: string) => {
    requireOpen();
    const normalized = text.trim();
    if (!normalized || normalized.length > 4000) {
      throw new InformationError("INVALID_INPUT", "Comment must be non-blank and at most 4000 characters");
    }
    return updateArticle(validId(rawItemId, "itemId"), (feedback) => {
      const timestamp = now();
      feedback.comments.push({
        id: `comment_${randomUUID()}`,
        text: normalized,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return feedback;
    });
  };

  const deleteArticleComment = (rawItemId: string, commentId: string) => {
    requireOpen();
    const itemId = validId(rawItemId, "itemId");
    return updateArticle(itemId, (feedback) => {
      const index = feedback.comments.findIndex((comment) => comment.id === commentId);
      if (index < 0) throw new InformationError("NOT_FOUND", "Information comment not found");
      feedback.comments.splice(index, 1);
      return feedback;
    });
  };

  const ingest = async (inputs: readonly InformationInputItem[], options?: { bulkImport?: boolean }) => {
    requireOpen();
    const state = await deps.repository.read();
    if (!state.settings.enabled) throw new InformationError("DISABLED", "Information ingestion is disabled");
    if (options?.bulkImport) bulkImportHoldUntil = Date.now() + BULK_IMPORT_HOLD_MS;
    const result = await deps.repository.update((current) => {
      if (!current.settings.enabled) throw new InformationError("DISABLED", "Information ingestion is disabled");
      const acceptedAt = now();
      const existing = new Map(current.items.map((item) => [keyOf(item.source, item.externalId), item]));
      const batch = new Map<string, InformationInputItem & { id: string }>();
      const returned: InformationItem[] = [];
      for (const input of inputs) {
        const key = keyOf(input.source, input.externalId);
        const stored = existing.get(key);
        if (stored) {
          if (!matchesStoredInput(stored, input)) {
            throw new InformationError("CONFLICT", "Information source and externalId conflict with existing content");
          }
          if (!returned.some((item) => keyOf(item.source, item.externalId) === key)) returned.push(stored);
          continue;
        }
        const previous = batch.get(key);
        if (previous) {
          if (!sameNewInput(previous, input)) {
            throw new InformationError("CONFLICT", "Duplicate information key has different content");
          }
          continue;
        }
        batch.set(key, { ...input, id: `info_${randomUUID()}` });
      }
      const planned = [...batch.entries()].map(([key, input]) => {
        const item: InformationItem = {
          id: input.id,
          source: input.source,
          externalId: input.externalId,
          ...(input.title ? { title: input.title } : {}),
          content: input.content,
          receivedAt: input.receivedAt ?? acceptedAt,
          acceptedAt,
          status: "pending",
          ...(input.metadata ? { metadata: input.metadata } : {}),
        };
        void key;
        returned.push(item);
        return item;
      });
      // 大批量分片导入仅在确实新增了待处理短信时进入首轮建画像与终审简报波次，防止重导已分析短信误触发全量重跑。
      const resetInitial = Boolean(options?.bulkImport) && planned.length > 0;
      return {
        state: {
          ...current,
          ...(resetInitial ? { initialAnalysisCompleted: false } : {}),
          items: [...current.items, ...planned],
        },
        result: returned,
      };
    }, { allowCreate: true });
    if (options?.bulkImport) bulkImportHoldUntil = Date.now() + BULK_IMPORT_HOLD_MS;
    return result;
  };

  const ingestNews = async (inputs: readonly InformationInputItem[]) => {
    requireOpen();
    return deps.repository.update((current) => {
      if (current.settings.mode !== "recommendations") {
        throw new InformationError("CONFLICT", "Information agent is not in recommendation mode");
      }
      const acceptedAt = now();
      const existing = new Set(current.items.map((item) => keyOf(item.source, item.externalId)));
      const added: InformationItem[] = [];
      for (const input of inputs) {
        const key = keyOf(input.source, input.externalId);
        if (existing.has(key)) continue;
        existing.add(key);
        added.push({
          id: `info_${randomUUID()}`,
          source: input.source,
          externalId: input.externalId,
          ...(input.title ? { title: input.title } : {}),
          content: input.content,
          receivedAt: input.receivedAt ?? acceptedAt,
          acceptedAt,
          status: "pending",
          ...(input.metadata ? { metadata: input.metadata } : {}),
        });
      }
      return {
        state: { ...current, items: [...current.items, ...added] },
        result: added,
      };
    });
  };

  const listItems = async (options: { status?: string; limit?: number; cursor?: string }) => {
    const status = options.status;
    if (status !== undefined && !ITEM_STATUSES.has(status as InformationItemStatus)) {
      throw new InformationError("INVALID_INPUT", "Invalid information item status");
    }
    const values = sortedItems((await deps.repository.read()).items)
      .filter((item) => !status || item.status === status);
    const result = page(values, (item) => item.acceptedAt, options.limit ?? 20, options.cursor, status);
    return { items: result.values, nextCursor: result.nextCursor };
  };
  const getItem = async (rawItemId: string) => {
    const itemId = validId(rawItemId, "itemId");
    const state = await deps.repository.read();
    const item = state.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new InformationError("NOT_FOUND", "Information item not found");
    return { item, runs: sortedRuns(state.runs.filter((run) => run.itemIds.includes(itemId))) };
  };
  const listRuns = async (options: { status?: string; limit?: number; cursor?: string }) => {
    const status = options.status;
    if (status !== undefined && !RUN_STATUSES.has(status as InformationRun["status"])) {
      throw new InformationError("INVALID_INPUT", "Invalid information run status");
    }
    const values = sortedRuns((await deps.repository.read()).runs)
      .filter((run) => !status || run.status === status);
    const result = page(values, (run) => run.createdAt, options.limit ?? 20, options.cursor, status);
    return { runs: result.values, nextCursor: result.nextCursor };
  };
  const getRun = async (rawRunId: string) => {
    const runId = validId(rawRunId, "runId");
    const state = await deps.repository.read();
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new InformationError("NOT_FOUND", "Information run not found");
    return {
      run,
      items: run.itemIds.map((itemId) => state.items.find((item) => item.id === itemId))
        .filter((item): item is InformationItem => Boolean(item)),
    };
  };

  const recommendationByItem = (state: InformationState) => {
    const recommendations = new Map<string, { reason: string }>();
    for (const run of sortedRuns(state.runs)) {
      if (run.status !== "completed" || run.model?.status !== "succeeded" || !run.decisions) continue;
      for (const decision of run.decisions) {
        if (decision.decision === "notify" && !recommendations.has(decision.itemId)) {
          recommendations.set(decision.itemId, { reason: decision.reason });
        }
      }
    }
    return recommendations;
  };
  const newsArticle = (
    state: InformationState,
    item: InformationItem,
    recommendations: ReadonlyMap<string, { reason: string }>,
  ) => {
    const feedback = state.articleFeedback.find((candidate) => candidate.itemId === item.id);
    return {
      id: item.id,
      sourceId: item.metadata!.sourceId,
      sourceTitle: item.metadata!.sourceTitle,
      title: item.title ?? "Untitled",
      url: item.metadata!.url,
      content: item.content,
      publishedAt: item.receivedAt,
      acceptedAt: item.acceptedAt,
      recommendation: recommendations.get(item.id) ?? null,
      feedback: {
        reaction: feedback?.reaction ?? null,
        saved: feedback?.saved ?? false,
        comments: feedback?.comments ?? [],
      },
    };
  };
  const listNewsArticles = async (
    options: {
      view: "recommended" | "all";
      savedOnly: boolean;
      limit: number;
      cursor?: string;
    },
  ) => {
    const state = await deps.repository.read();
    if (state.settings.mode !== "recommendations") {
      throw new InformationError("NOT_FOUND", "News agent not found");
    }
    const cursor = options.cursor ? decodeNewsCursor(options.cursor) : undefined;
    if (options.cursor && (!cursor || cursor.view !== options.view || cursor.savedOnly !== options.savedOnly)) {
      throw new InformationError("INVALID_INPUT", "Invalid news cursor");
    }
    const recommendations = recommendationByItem(state);
    const feedbackByItem = new Map(state.articleFeedback.map((feedback) => [feedback.itemId, feedback]));
    const filtered = state.items
      .filter((item) => Boolean(item.metadata))
      .filter((item) => options.view === "all" || recommendations.has(item.id))
      .filter((item) => !options.savedOnly || feedbackByItem.get(item.id)?.saved === true)
      .sort((left, right) =>
        right.receivedAt.localeCompare(left.receivedAt) || right.id.localeCompare(left.id))
      .filter((item) => !cursor ||
        item.receivedAt < cursor.publishedAt ||
        (item.receivedAt === cursor.publishedAt && item.id < cursor.id));
    const pageWithExtra = filtered.slice(0, options.limit + 1);
    const values = pageWithExtra
      .slice(0, options.limit)
      .map((item) => newsArticle(state, item, recommendations));
    const last = values.at(-1);
    return {
      articles: values,
      nextCursor: pageWithExtra.length > options.limit && last
        ? Buffer.from(JSON.stringify({
          publishedAt: last.publishedAt,
          id: last.id,
          view: options.view,
          savedOnly: options.savedOnly,
        } satisfies NewsCursor), "utf8").toString("base64url")
        : null,
    };
  };
  const getNewsArticle = async (rawItemId: string) => {
    const itemId = validId(rawItemId, "articleId");
    const state = await deps.repository.read();
    const item = state.items.find((candidate) => candidate.id === itemId && candidate.metadata);
    if (!item || state.settings.mode !== "recommendations") {
      throw new InformationError("NOT_FOUND", "News article not found");
    }
    return { article: newsArticle(state, item, recommendationByItem(state)) };
  };
  const getNewsCounts = async () => {
    const state = await deps.repository.read();
    return {
      processing: Boolean(active),
      pendingCount: state.items.filter((item) => item.status === "pending").length,
      failedCount: state.items.filter((item) => item.status === "failed").length,
    };
  };
  const retryFailedNews = async () => {
    if (Boolean(active)) return { resetCount: 0, resetDeferred: true };
    return deps.repository.update((state) => {
      let changed = 0;
      const items = state.items.map((item) => {
        if (item.status !== "failed") return item;
        changed++;
        return { ...item, status: "pending" as const };
      });
      return {
        state: changed ? { ...state, items } : undefined,
        result: { resetCount: changed, resetDeferred: false },
      };
    });
  };

  const claim = async (force: boolean, options?: { forceInitial?: boolean }) =>
    deps.repository.update((state) => {
      if (isPaused()) return { result: undefined as InformationRun | undefined };
      if (!state.settings.enabled) return { result: undefined as InformationRun | undefined };
      const pending = [...state.items]
        .filter((item) => item.status === "pending")
        .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
      const first = pending[0];
      if (!first) return { result: undefined };
      if (!force && Date.now() < Date.parse(first.acceptedAt) + state.settings.batchWindowSeconds * 1000) {
        return { result: undefined };
      }
      const isInitial = Boolean(options?.forceInitial) || !state.initialAnalysisCompleted;
      const maxItems = isInitial && state.settings.mode === "notifications"
        ? MAX_INITIAL_INFORMATION_ITEMS_PER_BATCH
        : MAX_INFORMATION_ITEMS_PER_BATCH;
      const selected: InformationItem[] = [];
      let chars = 0;
      for (const item of pending) {
        if (selected.length >= maxItems) break;
        if (selected.length && chars + item.content.length > MAX_INFORMATION_BATCH_CHARS) continue;
        selected.push(item);
        chars += item.content.length;
      }
      const nowText = now();
      const run: InformationRun = {
        id: `inforun_${randomUUID()}`,
        itemIds: selected.map((item) => item.id),
        status: "running",
        createdAt: nowText,
        startedAt: nowText,
        kind: isInitial ? "initial_summary" : "incremental",
        publications: [],
      };
      const selectedIds = new Set(run.itemIds);
      return {
        state: {
          ...state,
          ...(options?.forceInitial ? { initialAnalysisCompleted: false } : {}),
          items: state.items.map((item) => selectedIds.has(item.id)
            ? { ...item, status: "processing" as const, runId: run.id }
            : item),
          runs: [...state.runs, run],
        },
        result: run,
      };
    });

  const failRun = async (runId: string, error: string, cancelled = false) =>
    deps.repository.update((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run || run.status !== "running") return { result: undefined };
      const finishedAt = now();
      return {
        state: {
          ...state,
          items: state.items.map((item) => item.runId === runId && item.status === "processing"
            ? { ...item, status: "failed" }
            : item),
          runs: state.runs.map((candidate) => candidate.id === runId
            ? {
              ...candidate,
              status: cancelled ? "cancelled" as const : "failed" as const,
              finishedAt,
              model: { status: "failed" as const, error },
            }
            : candidate),
        },
        result: undefined,
      };
    });

  const markPublication = async (
    runId: string,
    notificationId: string,
    outcome: { status: "published"; receipt: { piSessionId: string; messageId: string } } | { status: "failed"; error: string },
  ) => deps.repository.update((state) => ({
    state: {
      ...state,
      runs: state.runs.map((run) => run.id !== runId ? run : {
        ...run,
        publications: run.publications.map((publication) => publication.notificationId !== notificationId
          ? publication
          : outcome.status === "published"
            ? { ...publication, status: "published", receipt: { ...outcome.receipt, notificationId } }
            : { ...publication, status: "failed", error: outcome.error }),
      }),
    },
    result: undefined,
  }));

  const oneLine = (value: string, maxChars: number) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
  };

  const extractIdentifiers = (title: string | undefined, content: string): string[] => {
    const haystack = `${title ?? ""} ${content}`;
    const codes = [...haystack.matchAll(/\b[A-Za-z]{1,6}[-_]?\d{3,}[A-Za-z0-9-]*\b/g)]
      .map((match) => match[0].replace(/[-_]/g, "").toUpperCase());
    const cardTails = [...haystack.matchAll(/(?:尾号|卡号)\s*([0-9]{4})/g)]
      .map((match) => `TAIL:${match[1]}`);
    return [...new Set([...codes, ...cardTails])];
  };

  const buildFallbackBriefing = (args: {
    totalScanned: number;
    silentCount: number;
    learnedNotes: string;
    candidates: readonly InformationBriefingCandidate[];
  }): { itemIds: string[]; text: string } => {
    const { totalScanned, silentCount, learnedNotes, candidates } = args;
    const profileNote = learnedNotes.trim()
      ? `；已整理常用偏好画像：${oneLine(learnedNotes, 120)}`
      : "";
    if (!candidates.length) {
      const text = oneLine(
        `已完成 ${totalScanned} 条历史短信全量梳理（已过滤 ${silentCount} 条营销与历史通知${profileNote}）。当前暂无待处理事项，后续新短信已进入静默守护模式。`,
        INITIAL_BRIEFING_MAX_LENGTH,
      );
      return { itemIds: [], text };
    }
    const maxListed = 6;
    const header = `已完成 ${totalScanned} 条历史短信梳理（过滤 ${silentCount} 条历史与营销短信${profileNote}），当前重点待办：`;
    const lines: string[] = [header];
    const selected: InformationBriefingCandidate[] = [];
    for (const candidate of candidates.slice(0, maxListed)) {
      const prefix = candidate.title ? `[${oneLine(candidate.title, 24)}] ` : "";
      const bullet = `• ${prefix}${oneLine(candidate.content, 110)}`;
      const remainingAfter = candidates.length - (selected.length + 1);
      const footerReserve = remainingAfter > 0 ? `\n另有 ${remainingAfter} 条提醒已归档，可在短信队列中查看。` : "";
      if ([...lines, bullet].join("\n").length + footerReserve.length > INITIAL_BRIEFING_MAX_LENGTH) break;
      lines.push(bullet);
      selected.push(candidate);
    }
    if (!selected.length) {
      const first = candidates[0]!;
      const fallbackBullet = `• ${oneLine(first.content, 120)}`;
      lines.push(fallbackBullet);
      selected.push(first);
    }
    const omitted = candidates.length - selected.length;
    if (omitted > 0) {
      lines.push(`另有 ${omitted} 条较早提醒已归档，可在短信队列中查看。`);
    }
    const raw = lines.join("\n");
    return {
      itemIds: selected.map((candidate) => candidate.itemId),
      text: raw.length > INITIAL_BRIEFING_MAX_LENGTH ? `${raw.slice(0, INITIAL_BRIEFING_MAX_LENGTH - 1)}…` : raw,
    };
  };

  /** 从已落盘状态回溯收集本波连续 initial_summary 批次的统计、待办候选与跨批状态变更线索。 */
  const collectInitialWave = (
    state: InformationState,
    currentClaimed: InformationRun,
    currentDecisions: readonly InformationDecision[],
  ) => {
    const claimedIndex = state.runs.findIndex((candidate) => candidate.id === currentClaimed.id);
    const stopIndex = claimedIndex >= 0 ? claimedIndex : state.runs.length;
    const priorRuns: InformationRun[] = [];
    for (let i = stopIndex - 1; i >= 0; i--) {
      const candidate = state.runs[i]!;
      if (candidate.kind !== "initial_summary" || candidate.publications.length > 0) break;
      if (candidate.status === "completed") priorRuns.unshift(candidate);
    }
    const waveRuns: Array<Pick<InformationRun, "itemIds" | "decisions">> = [
      ...priorRuns,
      { itemIds: currentClaimed.itemIds, decisions: [...currentDecisions] },
    ];
    const itemById = new Map(state.items.map((item) => [item.id, item]));
    const seenScanned = new Set<string>();
    const seenCandidates = new Set<string>();
    let silentCount = 0;
    const allCandidates: InformationBriefingCandidate[] = [];
    const silentEntries: Array<{ item: InformationItem; reason: string }> = [];

    for (const run of waveRuns) {
      for (const itemId of run.itemIds) seenScanned.add(itemId);
      for (const decision of run.decisions ?? []) {
        const item = itemById.get(decision.itemId);
        if (!item) continue;
        if (decision.decision === "notify") {
          if (seenCandidates.has(item.id)) continue;
          seenCandidates.add(item.id);
          allCandidates.push({
            itemId: item.id,
            source: item.source,
            ...(item.title ? { title: item.title } : {}),
            content: item.content.slice(0, 400),
            receivedAt: item.receivedAt,
            reason: decision.reason,
          });
        } else {
          silentCount++;
          silentEntries.push({ item, reason: decision.reason });
        }
      }
    }

    allCandidates.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.itemId.localeCompare(a.itemId));
    const candidates = allCandidates.slice(0, MAX_BRIEFING_CANDIDATES);

    const identifierMinAt = new Map<string, string>();
    for (const candidate of candidates) {
      for (const id of extractIdentifiers(candidate.title, candidate.content)) {
        const prev = identifierMinAt.get(id);
        if (!prev || candidate.receivedAt < prev) identifierMinAt.set(id, candidate.receivedAt);
      }
    }
    const relatedUpdates: InformationBriefingUpdate[] = [];
    if (identifierMinAt.size > 0) {
      const seenUpdates = new Set<string>();
      for (const { item, reason } of silentEntries) {
        if (seenUpdates.has(item.id)) continue;
        const matched = extractIdentifiers(item.title, item.content).some((id) => {
          const minAt = identifierMinAt.get(id);
          return minAt !== undefined && item.receivedAt >= minAt;
        });
        if (!matched) continue;
        seenUpdates.add(item.id);
        relatedUpdates.push({
          itemId: item.id,
          ...(item.title ? { title: item.title } : {}),
          content: item.content.slice(0, 400),
          receivedAt: item.receivedAt,
          reason,
        });
      }
      relatedUpdates.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.itemId.localeCompare(a.itemId));
    }

    return {
      batchCount: waveRuns.length,
      totalScanned: seenScanned.size,
      silentCount,
      candidates,
      relatedUpdates: relatedUpdates.slice(0, MAX_BRIEFING_UPDATES),
    };
  };

  const process = async (slot: ActiveSlot, claimed: InformationRun) => {
    const { controller } = slot;
    const finish = deps.observeWork?.("main", "information", "正在整理信息");
    let succeeded = false;
    let meaningful = false;
    let cancelled = false;
    let deliveryFailed = false;
    let retained: Awaited<ReturnType<typeof deps.retainMain>> | undefined;
    try {
      controller.signal.throwIfAborted();
      const initialState = await deps.repository.read();
      const mode = initialState.settings.mode;
      let targetSessionId: string | undefined;
      if (mode === "notifications") {
        retained = await deps.retainMain();
        controller.signal.throwIfAborted();
        if (!retained) {
          cancelled = true;
          await failRun(claimed.id, "Target agent disappeared", true);
          return;
        }
        targetSessionId = retained.conversation.piSessionId();
      }
      {
        const state = initialState;
        const claimedIds = new Set(claimed.itemIds);
        const items = claimed.itemIds
          .map((id) => state.items.find((item) => item.id === id))
          .filter((item): item is InformationItem => Boolean(item));
        const analysisKind = claimed.kind ?? (!initialState.initialAnalysisCompleted ? "initial_summary" : "incremental");
        const remainingOnStart = state.items.filter(
          (item) => item.status === "pending" && !claimedIds.has(item.id),
        ).length;
        const claimedIndex = state.runs.findIndex((candidate) => candidate.id === claimed.id);
        const stopIndex = claimedIndex >= 0 ? claimedIndex : state.runs.length;
        let hasPriorInitialWaveRun = false;
        for (let i = stopIndex - 1; i >= 0; i--) {
          const candidate = state.runs[i]!;
          if (candidate.kind !== "initial_summary" || candidate.publications.length > 0) break;
          if (candidate.status === "completed") {
            hasPriorInitialWaveRun = true;
            break;
          }
        }
        const mapOnly = mode === "notifications" &&
          analysisKind === "initial_summary" &&
          (items.length >= 10 || remainingOnStart > 0 || hasPriorInitialWaveRun);
        const input: InformationModelInput = {
          runId: claimed.id,
          mode,
          analysisKind,
          ...(mapOnly ? { mapOnly: true } : {}),
          preferences: state.preferences,
          items: items.map(({ id, source, externalId, title, content, receivedAt, metadata }) => ({
            id, source, externalId, ...(title ? { title } : {}), content, receivedAt,
            ...(metadata ? { sourceTitle: metadata.sourceTitle, url: metadata.url } : {}),
          })),
          feedbackExamples: mode === "notifications" && targetSessionId ? await feedbackExamples(state, targetSessionId) : [],
          articleFeedback: articleFeedbackExamples(state),
        };
        controller.signal.throwIfAborted();
        const result = await deps.runModel(input, controller.signal);
        if (!result.ok) {
          cancelled = result.error === "CANCELLED";
          await failRun(claimed.id, result.error, result.error === "CANCELLED");
          return;
        }
        let parsed: ReturnType<typeof parseInformationResult>;
        try {
          parsed = parseInformationResult(result.result, claimed.itemIds, mode, {
            requireNotificationCoverage: mode === "notifications" && !mapOnly,
          });
        } catch {
          await failRun(claimed.id, "INVALID_MODEL_RESULT");
          return;
        }
        // 模型已成功时先保留这个事实；若取消/目标会话已变化，只把投递标失败，不重跑模型。
        let deliveryCancelled = mode === "notifications" && (
          controller.signal.aborted || retained!.conversation.piSessionId() !== targetSessionId
        );
        const stateBeforeCommit = await deps.repository.read();
        const remainingBeforeReduce = stateBeforeCommit.items.filter(
          (item) => item.status === "pending" && !claimedIds.has(item.id),
        );

        let preparedNotifications: Array<{ itemIds: string[]; text: string }> = mode === "notifications"
          ? parsed.notifications
          : [];
        let reduceCancelled = false;
        if (mode === "notifications" && analysisKind === "initial_summary") {
          if (remainingBeforeReduce.length > 0) {
            preparedNotifications = [];
          } else {
            const wave = collectInitialWave(stateBeforeCommit, claimed, parsed.decisions);
            const effectiveLearnedNotes = parsed.learnedNotes ?? stateBeforeCommit.preferences.learnedNotes;
            const singleFastPath =
              wave.batchCount === 1 &&
              wave.totalScanned < 10 &&
              parsed.notifications.length === 1 &&
              parsed.notifications[0]!.text.trim().length <= INITIAL_BRIEFING_MAX_LENGTH;
            if (deliveryCancelled) {
              preparedNotifications = singleFastPath
                ? [{ itemIds: parsed.notifications[0]!.itemIds, text: parsed.notifications[0]!.text.trim() }]
                : parsed.notifications;
            } else if (wave.batchCount === 1 && wave.candidates.length === 0 && wave.totalScanned < 10) {
              preparedNotifications = [];
            } else if (singleFastPath) {
              preparedNotifications = [{
                itemIds: parsed.notifications[0]!.itemIds,
                text: parsed.notifications[0]!.text.trim(),
              }];
            } else if (deps.synthesizeBriefing) {
              const briefingOutcome = await deps.synthesizeBriefing({
                runId: claimed.id,
                preferences: {
                  ...stateBeforeCommit.preferences,
                  learnedNotes: effectiveLearnedNotes,
                },
                totalScanned: wave.totalScanned,
                silentCount: wave.silentCount,
                batchCount: wave.batchCount,
                candidates: wave.candidates,
                ...(wave.relatedUpdates.length ? { relatedUpdates: wave.relatedUpdates } : {}),
              }, controller.signal);
              if (briefingOutcome.ok) {
                const boundedText = briefingOutcome.text.trim().slice(0, INITIAL_BRIEFING_MAX_LENGTH);
                preparedNotifications = [{
                  itemIds: briefingOutcome.itemIds,
                  text: boundedText,
                }];
              } else if (briefingOutcome.error === "CANCELLED" || controller.signal.aborted) {
                reduceCancelled = true;
                preparedNotifications = [buildFallbackBriefing({
                  totalScanned: wave.totalScanned,
                  silentCount: wave.silentCount,
                  learnedNotes: effectiveLearnedNotes,
                  candidates: wave.candidates,
                })];
              } else {
                preparedNotifications = [buildFallbackBriefing({
                  totalScanned: wave.totalScanned,
                  silentCount: wave.silentCount,
                  learnedNotes: effectiveLearnedNotes,
                  candidates: wave.candidates,
                })];
              }
            } else {
              preparedNotifications = [buildFallbackBriefing({
                totalScanned: wave.totalScanned,
                silentCount: wave.silentCount,
                learnedNotes: effectiveLearnedNotes,
                candidates: wave.candidates,
              })];
            }
          }
        }

        deliveryCancelled = mode === "notifications" && (
          reduceCancelled || controller.signal.aborted || retained!.conversation.piSessionId() !== targetSessionId
        );
        const deliveryError = controller.signal.aborted || reduceCancelled
          ? "Cancelled before notification delivery"
          : "Target session changed before notification delivery";

        await deps.repository.update((current) => {
          const run = current.runs.find((candidate) => candidate.id === claimed.id);
          if (!run || run.status !== "running") return { result: undefined };
          const remainingNow = current.items.filter((item) => item.status === "pending" && !claimedIds.has(item.id));
          const deferredByNewItems = mode === "notifications" &&
            analysisKind === "initial_summary" &&
            remainingNow.length > 0 &&
            !deliveryCancelled;
          const effectiveNotifications = deferredByNewItems ? [] : preparedNotifications;
          const publications = mode === "notifications" ? effectiveNotifications.map((notification, index) => ({
            notificationId: `info-notification-${claimed.id}-${index}`,
            itemIds: notification.itemIds,
            text: notification.text,
            status: deliveryCancelled ? "failed" as const : "pending" as const,
            ...(deliveryCancelled ? { error: deliveryError } : {}),
          })) : [];
          const hasFailedItems = current.items.some((item) => item.status === "failed");
          const initialCompleted = current.initialAnalysisCompleted ||
            (analysisKind === "initial_summary" && remainingNow.length === 0 && !reduceCancelled && !hasFailedItems);
          return {
            state: {
              ...current,
              initialAnalysisCompleted: initialCompleted,
              preferences: parsed.learnedNotes !== undefined
                ? { ...current.preferences, learnedNotes: parsed.learnedNotes }
                : current.preferences,
              items: current.items.map((item) => item.runId === claimed.id && item.status === "processing"
                ? { ...item, status: "processed" as const }
                : item),
              runs: current.runs.map((candidate) => candidate.id === claimed.id
                ? {
                  ...candidate,
                  status: "completed" as const,
                  finishedAt: now(),
                  model: { status: "succeeded" as const },
                  decisions: parsed.decisions,
                  publications,
                }
                : candidate),
            },
            result: undefined,
          };
        });
        if (deliveryCancelled) { cancelled = true; return; }
        const completed = await deps.repository.read();
        succeeded = true;
        meaningful = mode === "recommendations";
        const run = completed.runs.find((candidate) => candidate.id === claimed.id);
        for (const publication of run?.publications ?? []) {
          if (mode !== "notifications" || !retained || !targetSessionId) continue;
          const settingsNow = await deps.repository.read();
          if (!settingsNow.settings.enabled) {
            cancelled = true;
            await markPublication(claimed.id, publication.notificationId, {
              status: "failed", error: "Information processing disabled before notification delivery",
            });
            continue;
          }
          if (controller.signal.aborted) {
            await markPublication(claimed.id, publication.notificationId, {
              status: "failed", error: "Cancelled before notification delivery",
            });
            continue;
          }
          if (retained.conversation.piSessionId() !== targetSessionId) {
            deliveryFailed = true;
            await markPublication(claimed.id, publication.notificationId, {
              status: "failed", error: "Target session changed before notification delivery",
            });
            continue;
          }
          try {
            const receipt = await retained.conversation.notify(
              publication.text,
              publication.notificationId,
              { signal: controller.signal, domainId: deps.domainId ?? "sms" },
            );
            await markPublication(claimed.id, publication.notificationId, {
              status: "published", receipt,
            });
            meaningful = true;
          } catch {
            deliveryFailed = !controller.signal.aborted;
            await markPublication(claimed.id, publication.notificationId, {
              status: "failed", error: controller.signal.aborted
                ? "Cancelled before notification delivery"
                : "Notification delivery failed",
            });
          }
        }
      }
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = error instanceof Error && error.message === "Notification cancelled"
        ? "Cancelled before notification delivery"
        : cancelled ? "CANCELLED" : "Information processing failed";
      await failRun(claimed.id, message, cancelled).catch(() => undefined);
      // 取消是已接纳 run 的正常终态：runNow 继续读回 cancelled 记录，不能把 AbortError 冒成 HTTP 500。
      if (!cancelled && (!(error instanceof InformationError) || error.code !== "SHUTDOWN")) throw error;
    } finally {
      finish?.(controller.signal.aborted || cancelled ? "cancelled" : succeeded && !deliveryFailed ? "succeeded" : "failed", meaningful);
      retained?.release();
    }
  };

  /** 首轮历史分析模式下在同一个执行槽内连续排空所有待处理批次，每批持久化结论，最终只经 Reduce 终审投递 1 张简报。 */
  const drainClaimed = async (slot: ActiveSlot, firstClaimed: InformationRun): Promise<InformationRun> => {
    let current = firstClaimed;
    while (true) {
      const isInitial = current.kind === "initial_summary";
      await process(slot, current);
      if (!isInitial || slot.controller.signal.aborted) break;
      const stateNow = await deps.repository.read();
      const finishedRun = stateNow.runs.find((candidate) => candidate.id === current.id);
      if (!finishedRun || finishedRun.status !== "completed" || stateNow.initialAnalysisCompleted) break;
      if (!stateNow.settings.enabled || !stateNow.items.some((item) => item.status === "pending")) break;
      const next = await claim(true);
      if (!next) break;
      current = next;
    }
    return current;
  };

  const runNow = async (options?: { background?: boolean; forceInitial?: boolean; retryFailed?: boolean }) => {
    requireOpen();
    if (isPaused()) throw new InformationError("SESSION_PAUSED", "Agent lifecycle is changing");
    bulkImportHoldUntil = 0;
    const slot = reserveSlot();
    let backgroundStarted = false;
    try {
      const initialState = await deps.repository.read();
      if (!initialState.settings.enabled) throw new InformationError("DISABLED", "Information processing is disabled");
      if (options?.retryFailed) {
        await deps.repository.update((current) => {
          if (!current.settings.enabled) throw new InformationError("DISABLED", "Information processing is disabled");
          let resetCount = 0;
          const items = current.items.map((item) => {
            if (item.status !== "failed") return item;
            resetCount++;
            const { runId: _droppedRunId, ...rest } = item;
            void _droppedRunId;
            return { ...rest, status: "pending" as const };
          });
          if (!resetCount) return { result: 0 };
          const shouldResetInitial = Boolean(options.forceInitial) || !current.initialAnalysisCompleted;
          return {
            state: {
              ...current,
              ...(shouldResetInitial ? { initialAnalysisCompleted: false } : {}),
              items,
            },
            result: resetCount,
          };
        });
      }
      const state = options?.retryFailed ? await deps.repository.read() : initialState;
      if (!state.items.some((item) => item.status === "pending")) {
        throw new InformationError("NO_PENDING", "No pending information");
      }
      const claimed = await claim(true, { forceInitial: options?.forceInitial });
      if (!claimed) throw new InformationError("NO_PENDING", "No pending information");
      if (options?.background) {
        backgroundStarted = true;
        void drainClaimed(slot, claimed)
          .catch(() => undefined)
          .finally(() => slot.release());
        return getRun(claimed.id);
      }
      const lastClaimed = await drainClaimed(slot, claimed);
      return getRun(lastClaimed.id);
    } finally {
      if (!backgroundStarted) slot.release();
    }
  };
  const getStatus = async () => {
    const state = await deps.repository.read();
    let pending = 0;
    let processing = 0;
    let processed = 0;
    let failed = 0;
    for (const item of state.items) {
      if (item.status === "pending") pending++;
      else if (item.status === "processing") processing++;
      else if (item.status === "processed") processed++;
      else if (item.status === "failed") failed++;
    }
    const recentRuns = sortedRuns(state.runs);
    let latestBriefing:
      | {
          runId: string;
          notificationId: string;
          text: string;
          createdAt: string;
          itemCount: number;
          messageId?: string;
        }
      | undefined;
    for (const run of recentRuns) {
      if (run.kind !== "initial_summary") continue;
      const published = run.publications.find((publication) => publication.status === "published");
      if (!published) continue;
      latestBriefing = {
        runId: run.id,
        notificationId: published.notificationId,
        text: published.text,
        createdAt: run.finishedAt ?? run.createdAt,
        itemCount: published.itemIds.length,
        ...(published.receipt?.messageId ? { messageId: published.receipt.messageId } : {}),
      };
      break;
    }
    let lastError: string | undefined;
    if (failed > 0 || recentRuns[0]?.status === "failed") {
      for (const run of recentRuns) {
        if (run.status === "failed" && run.model?.error) {
          lastError = run.model.error;
          break;
        }
        const failedPublication = run.publications.find((publication) => publication.status === "failed" && publication.error);
        if (failedPublication?.error) {
          lastError = failedPublication.error;
          break;
        }
      }
    }
    return {
      running: Boolean(active),
      initialAnalysisCompleted: Boolean(state.initialAnalysisCompleted),
      counts: {
        total: state.items.length,
        pending,
        processing,
        processed,
        failed,
      },
      ...(latestBriefing ? { latestBriefing } : {}),
      ...(lastError ? { lastError } : {}),
    };
  };
  const runDue = () => {
    if (closed || active || isPaused() || Date.now() < bulkImportHoldUntil) return Promise.resolve(false);
    const slot = reserveSlot();
    let processStarted = false;
    return (async () => {
      try {
        if (isPaused() || Date.now() < bulkImportHoldUntil) return false;
        const claimed = await claim(false);
        if (!claimed) return false;
        processStarted = true;
        void drainClaimed(slot, claimed)
          .catch(() => undefined)
          .finally(() => slot.release());
        return true;
      } finally {
        // drainClaimed 接管后由其 finally 释放；未到期/无待处理在这里立即释放全局槽。
        if (!processStarted) slot.release();
      }
    })();
  };
  const nextDue = async () => {
    if (Date.now() < bulkImportHoldUntil) return false;
    const state = await deps.repository.read();
    if (!state.settings.enabled || isPaused()) return false;
    const first = state.items.filter((item) => item.status === "pending").sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt))[0];
    return Boolean(first && Date.now() >= Date.parse(first.acceptedAt) + state.settings.batchWindowSeconds * 1000);
  };

  const query = async (input: {
      action: "overview" | "items" | "item" | "runs" | "run" | "preferences";
    status?: string;
    limit?: number;
    cursor?: string;
    itemId?: string;
    runId?: string;
  }) => {
    if (input.action === "overview") {
      const settings = await getSettings();
      const preferences = await getPreferences();
      const items = await listItems({ limit: 5 });
      const runs = await listRuns({ limit: 5 });
      return { settings, preferences, items, runs };
    }
    if (input.action === "preferences") return getPreferences();
    if (input.action === "item") return getItem(input.itemId ?? "");
    if (input.action === "run") return getRun(input.runId ?? "");
    if (input.action === "items") return listItems({ status: input.status, limit: input.limit, cursor: input.cursor });
    return listRuns({ status: input.status, limit: input.limit, cursor: input.cursor });
  };

  const cancel = async () => {
    const current = active;
    if (current) {
      abortQuietly(current.controller);
      await current.done;
    }
  };
  const abortQuietly = (controller: AbortController) => {
    if (controller.signal.aborted) return;
    try {
      controller.abort(new Error("Information processing cancelled"));
    } catch (error) {
      // 本项目只需要进入 aborted 状态；abort 分发本身不能让生命周期路由失败。
      void error;
    }
  };
  /** 同步暂停新后台轮并等待旧轮退出；嵌套调用用引用计数收口。 */
  const pause = (): PipelinePause => {
    pauses++;
    const current = active;
    if (current) abortQuietly(current.controller);
    let resumed = false;
    return {
      stopped: current ? current.done.then(() => undefined) : Promise.resolve(),
      resume: () => {
        if (resumed) return;
        resumed = true;
        pauses--;
      },
    };
  };
  const close = () => {
    if (closing) return closing;
    closed = true;
    const current = active;
    if (current) abortQuietly(current.controller);
    closing = (async () => { if (current) await current.done; })();
    return closing;
  };

  return {
    getSettings,
    saveSettings,
    configure,
    getPreferences,
    getNewsPreferences,
    savePreferences,
    ingest,
    ingestNews,
    listItems,
    getItem,
    listNewsArticles,
    getNewsArticle,
    getNewsCounts,
    retryFailedNews,
    setArticleReaction,
    setArticleSaved,
    addArticleComment,
    deleteArticleComment,
    listRuns,
    getRun,
    getStatus,
    runNow,
    runDue,
    nextDue,
    query,
    cancel,
    pause,
    close,
  };
};

export type InformationService = Awaited<ReturnType<typeof createInformationService>>;
