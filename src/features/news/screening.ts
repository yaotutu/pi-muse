import { randomUUID } from "node:crypto";
import type {
  ResolvedWorkspaceDocument,
  WorkspaceIncludeDiagnostic,
} from "../../shared/workspace-includes.js";
import { isWorkspaceText } from "../../shared/workspace-text.js";
import type { HabitsService } from "../habits/service.js";
import type { HabitItem, HabitPromptContext, HabitSignalPayload } from "../habits/types.js";
import { NewsError } from "./errors.js";
import type {
  NewsArticleFeedback,
  NewsArticleItem,
  NewsArticleReaction,
  NewsRepository,
  NewsScreeningDecision,
  NewsScreeningRun,
  NewsScreeningRunStatus,
} from "./types.js";

export const NEWS_BATCH_ITEMS = 12;
export const NEWS_BATCH_CHARS = 60_000;
export const NEWS_REASON_MAX_LENGTH = 1000;
export const NEWS_PREFERENCES_INSTRUCTIONS_MAX_LENGTH = 20_000;
export const MAX_RETAINED_NEWS_ARTICLES = 2000;

const MAX_FEEDBACK_ITEMS = 20;
const MAX_FEEDBACK_COMMENTS = 5;
const FEEDBACK_TEXT_LENGTH = 1000;
const FEEDBACK_CONTENT_LENGTH = 2000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const validId = (raw: string, label: string): string => {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!ID_PATTERN.test(value)) {
    throw new NewsError("INVALID_INPUT", `${label} must match [A-Za-z0-9][A-Za-z0-9_-]{0,127}`);
  }
  return value;
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeText = (value: string, label: string, maxLength: number): string => {
  if (!isWorkspaceText(value)) {
    throw new NewsError("INVALID_INPUT", `${label} contains unsupported control characters`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new NewsError("INVALID_INPUT", `${label} must be at most ${maxLength} characters`);
  }
  return trimmed;
};

const clipText = (text: string, maxLength: number) =>
  text.length > maxLength ? { text: text.slice(0, maxLength), truncated: true } : { text, truncated: false };

const sanitizeError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "News screening failed";
};

export type NewsScreeningResult = {
  decisions: NewsScreeningDecision[];
};

/** 校验并规范化新闻筛选模型的结构化工具输出（仅 decisions，偏好提炼由通用习惯引擎定期承担）。 */
export const parseNewsScreeningResult = (
  raw: unknown,
  claimedIds: readonly string[],
): NewsScreeningResult => {
  if (!isPlainRecord(raw)) {
    throw new NewsError("INVALID_INPUT", "Invalid news screening result");
  }
  const allowedKeys = new Set(["decisions"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new NewsError("INVALID_INPUT", `Unexpected field in news screening result: ${key}`);
    }
  }
  if (!Array.isArray(raw.decisions)) {
    throw new NewsError("INVALID_INPUT", "decisions must be an array");
  }
  const expectedIds = new Set(claimedIds);
  const seenIds = new Set<string>();
  const decisions: NewsScreeningDecision[] = [];
  for (const entry of raw.decisions) {
    if (!isPlainRecord(entry)) {
      throw new NewsError("INVALID_INPUT", "Each decision must be an object");
    }
    const { itemId, decision, reason, ...extra } = entry;
    if (Object.keys(extra).length > 0) {
      throw new NewsError("INVALID_INPUT", "Unexpected field in decision");
    }
    if (typeof itemId !== "string" || !expectedIds.has(itemId) || seenIds.has(itemId)) {
      throw new NewsError("INVALID_INPUT", `Invalid or duplicate decision itemId: ${String(itemId)}`);
    }
    if (decision !== "silent" && decision !== "notify") {
      throw new NewsError("INVALID_INPUT", `Invalid decision value: ${String(decision)}`);
    }
    if (typeof reason !== "string" || !reason.trim() || reason.length > NEWS_REASON_MAX_LENGTH) {
      throw new NewsError("INVALID_INPUT", "Decision reason is blank or exceeds limit");
    }
    seenIds.add(itemId);
    decisions.push({ itemId, decision, reason: reason.trim() });
  }
  if (seenIds.size !== expectedIds.size) {
    throw new NewsError("INVALID_INPUT", "decisions must cover every claimed item exactly once");
  }
  return { decisions };
};

export type NewsArticleFeedbackExample = {
  itemId: string;
  title?: string;
  sourceTitle?: string;
  contentExcerpt: string;
  reaction: NewsArticleReaction;
  saved: boolean;
  comments: Array<{ text: string; updatedAt: string }>;
  commentsTruncated?: boolean;
};

export type NewsScreeningModelInput = {
  runId: string;
  instructions: string;
  habits: HabitItem[];
  feedbackExamples: NewsArticleFeedbackExample[];
  items: Array<{
    id: string;
    source: string;
    externalId: string;
    title?: string;
    content: string;
    receivedAt: string;
    acceptedAt: string;
    metadata?: { sourceId: string; sourceTitle: string; url?: string | null };
  }>;
};

export type NewsScreeningModelOutcome =
  | { ok: true; result: NewsScreeningResult }
  | { ok: false; error: string };

export type NewsIngestItemInput = {
  source: string;
  externalId: string;
  title?: string;
  content: string;
  receivedAt?: string;
  metadata?: { sourceId: string; sourceTitle: string; url?: string | null };
};

export type NewsArticleView = {
  id: string;
  sourceId: string;
  sourceTitle: string;
  title: string;
  url: string | null;
  content: string;
  publishedAt: string;
  acceptedAt: string;
  recommendation: { reason: string } | null;
  feedback: {
    reaction: NewsArticleReaction;
    saved: boolean;
    comments: Array<{ id: string; text: string; createdAt: string; updatedAt: string }>;
  };
};

type ArticleCursor = {
  id: string;
  at: string;
  view: "recommended" | "all";
  savedOnly: boolean;
};

type RunCursor = {
  id: string;
  at: string;
  status?: NewsScreeningRunStatus;
};

const encodeCursor = (value: object) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const decodeCursor = <T extends Record<string, unknown>>(value: string): T | undefined => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    return isPlainRecord(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
};

export type CreateNewsScreeningDeps = {
  repository: NewsRepository;
  instructions: {
    read: () => Promise<string>;
    readResolved?: () => Promise<string>;
    inspect?: () => Promise<ResolvedWorkspaceDocument>;
    write: (content: string) => Promise<void>;
  };
  habits?: Pick<HabitsService, "getPromptContext">;
  maxRetainedArticles?: number;
  onFeedbackChanged?: (payload: HabitSignalPayload) => Promise<void> | void;
  onChanged?: (scope: "items" | "runs" | "preferences") => void;
  runModel: (input: NewsScreeningModelInput, signal: AbortSignal) => Promise<NewsScreeningModelOutcome>;
  observeWork?: (
    sessionId: string,
    key: string,
    label: string,
  ) => ((outcome: "succeeded" | "failed", silent?: boolean) => void) | undefined;
};

const emptyHabitContext = (): HabitPromptContext => ({
  habits: [],
  unconsolidatedSignals: [],
  unconsolidatedCount: 0,
});

const toNewsHabitSignal = (item: NewsArticleItem, fb: NewsArticleFeedback): HabitSignalPayload => {
  const excerpt = clipText(item.content, FEEDBACK_CONTENT_LENGTH);
  const recentComments = fb.comments.slice(-MAX_FEEDBACK_COMMENTS);
  return {
    targetId: item.id,
    kind: "news_article",
    ...(item.title ? { summary: clipText(item.title, FEEDBACK_TEXT_LENGTH).text } : {}),
    reaction: fb.reaction,
    saved: fb.saved,
    comments: recentComments.map((comment) => clipText(comment.text, FEEDBACK_TEXT_LENGTH).text),
    commentsTruncated:
      fb.comments.length > MAX_FEEDBACK_COMMENTS ||
      recentComments.some((comment) => comment.text.length > FEEDBACK_TEXT_LENGTH),
    items: [{
      id: item.id,
      source: item.source,
      ...(item.title ? { title: clipText(item.title, FEEDBACK_TEXT_LENGTH).text } : {}),
      content: excerpt.text,
      contentTruncated: excerpt.truncated,
    }],
    ...(item.metadata?.sourceTitle ? { meta: { sourceTitle: item.metadata.sourceTitle } } : {}),
    updatedAt: new Date().toISOString(),
  };
};

const signalsToNewsExamples = (signals: readonly HabitSignalPayload[]): NewsArticleFeedbackExample[] =>
  signals
    .filter((sig) => sig.kind === "news_article")
    .slice(0, MAX_FEEDBACK_ITEMS)
    .map((sig) => {
      const articleItem = sig.items?.[0];
      return {
        itemId: sig.targetId,
        ...(articleItem?.title ?? sig.summary ? { title: articleItem?.title ?? sig.summary } : {}),
        ...(sig.meta?.sourceTitle ? { sourceTitle: sig.meta.sourceTitle } : {}),
        contentExcerpt: articleItem?.content ?? "",
        reaction: sig.reaction,
        saved: sig.saved,
        comments: sig.comments.map((text) => ({ text, updatedAt: sig.updatedAt })),
        ...(sig.commentsTruncated ? { commentsTruncated: true } : {}),
      };
    });

/**
 * 独立的新闻筛选领域服务（Clean Break v3）：
 * - 去除无实际开关入口的伪 settings，支持超限文章有界裁剪（永不删除带反馈文章）。
 * - 偏好视图对称返回 instructions + includes 诊断 + habits + unconsolidatedFeedbackCount。
 */
export const createNewsScreeningService = (deps: CreateNewsScreeningDeps) => {
  const habitsPort: Pick<HabitsService, "getPromptContext"> = deps.habits ?? {
    getPromptContext: async () => emptyHabitContext(),
  };
  const maxRetainedArticles = Math.max(1, deps.maxRetainedArticles ?? MAX_RETAINED_NEWS_ARTICLES);
  let closed = false;
  let pauseDepth = 0;
  let activeController: AbortController | undefined;
  let activePromise: Promise<void> | undefined;

  const isPaused = () => pauseDepth > 0;
  const ensureOpen = () => {
    if (closed) throw new NewsError("SHUTDOWN", "News screening service is closing");
  };
  const notifyChanged = (scope: "items" | "runs" | "preferences") => {
    try {
      deps.onChanged?.(scope);
    } catch {
      // SSE 通知异常不影响核心存储。
    }
  };

  const emptyFeedbackFor = (itemId: string): NewsArticleFeedback => ({
    itemId,
    reaction: null,
    saved: false,
    comments: [],
  });

  const recommendationMap = (runs: readonly NewsScreeningRun[]) => {
    const map = new Map<string, string>();
    const ordered = [...runs].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
    );
    for (const run of ordered) {
      if (run.status !== "completed" || !run.decisions) continue;
      for (const decision of run.decisions) {
        if (decision.decision === "notify" && !map.has(decision.itemId)) {
          map.set(decision.itemId, decision.reason);
        }
      }
    }
    return map;
  };

  const projectArticle = (
    item: NewsArticleItem,
    recommendations: ReadonlyMap<string, string>,
    feedbackByItem: ReadonlyMap<string, NewsArticleFeedback>,
  ): NewsArticleView => {
    const reason = recommendations.get(item.id);
    const feedback = feedbackByItem.get(item.id);
    return {
      id: item.id,
      sourceId: item.metadata?.sourceId ?? item.source,
      sourceTitle: item.metadata?.sourceTitle ?? item.source,
      title: item.title ?? (item.content.slice(0, 80) || "Untitled"),
      url: item.metadata?.url ?? null,
      content: item.content,
      publishedAt: item.receivedAt || item.acceptedAt,
      acceptedAt: item.acceptedAt,
      recommendation: reason ? { reason } : null,
      feedback: {
        reaction: feedback?.reaction ?? null,
        saved: feedback?.saved ?? false,
        comments: feedback?.comments ?? [],
      },
    };
  };

  const getCounts = async () => {
    const state = await deps.repository.read();
    let pendingCount = 0;
    let failedCount = 0;
    for (const item of state.processing.items) {
      if (item.status === "pending") pendingCount++;
      else if (item.status === "failed") failedCount++;
    }
    return {
      processing: Boolean(activePromise),
      pendingCount,
      failedCount,
    };
  };

  const ingest = async (inputs: readonly NewsIngestItemInput[]): Promise<NewsArticleItem[]> => {
    ensureOpen();
    if (!inputs.length) return [];
    const now = new Date().toISOString();
    const accepted = await deps.repository.update((state) => {
      const seenKeys = new Set(state.processing.items.map((item) => `${item.source}\0${item.externalId}`));
      const next: NewsArticleItem[] = [];
      for (const input of inputs) {
        const key = `${input.source}\0${input.externalId}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        next.push({
          id: `news_${randomUUID()}`,
          source: input.source,
          externalId: input.externalId,
          ...(input.title !== undefined ? { title: input.title } : {}),
          content: input.content,
          receivedAt: input.receivedAt ?? now,
          acceptedAt: now,
          status: "pending",
          ...(input.metadata ? { metadata: input.metadata } : {}),
        });
      }
      if (!next.length) return { result: [] };
      return {
        state: {
          ...state,
          processing: {
            ...state.processing,
            items: [...state.processing.items, ...next],
          },
        },
        result: next,
      };
    });
    if (accepted.length > 0) notifyChanged("items");
    return accepted;
  };

  const retryFailed = async (): Promise<{ resetDeferred: boolean }> => {
    ensureOpen();
    if (activePromise) {
      const state = await deps.repository.read();
      return { resetDeferred: state.processing.items.some((item) => item.status === "failed") };
    }
    const result = await deps.repository.update<{ resetDeferred: boolean; resetCount: number }>((state) => {
      let resetCount = 0;
      const items = state.processing.items.map((item) => {
        if (item.status !== "failed") return item;
        resetCount++;
        const { runId: _drop, ...rest } = item;
        return { ...rest, status: "pending" as const };
      });
      if (!resetCount) return { result: { resetDeferred: false, resetCount: 0 } };
      return {
        state: {
          ...state,
          processing: { ...state.processing, items },
        },
        result: { resetDeferred: false, resetCount },
      };
    });
    if (result.resetCount > 0) notifyChanged("items");
    return { resetDeferred: result.resetDeferred };
  };

  const listArticles = async (options: {
    view: "recommended" | "all";
    savedOnly: boolean;
    limit: number;
    cursor?: string;
  }) => {
    const state = await deps.repository.read();
    let after: ArticleCursor | undefined;
    if (options.cursor !== undefined) {
      const decoded = decodeCursor<ArticleCursor>(options.cursor);
      if (
        !decoded ||
        typeof decoded.id !== "string" ||
        typeof decoded.at !== "string" ||
        decoded.view !== options.view ||
        decoded.savedOnly !== options.savedOnly
      ) {
        throw new NewsError("INVALID_INPUT", "Invalid articles cursor");
      }
      after = decoded;
    }
    const recommendations = recommendationMap(state.processing.runs);
    const feedbackByItem = new Map(state.processing.articleFeedback.map((fb) => [fb.itemId, fb]));
    const filtered = state.processing.items
      .filter((item) => {
        if (options.view === "recommended" && !recommendations.has(item.id)) return false;
        if (options.savedOnly && feedbackByItem.get(item.id)?.saved !== true) return false;
        return true;
      })
      .map((item) => projectArticle(item, recommendations, feedbackByItem))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id));

    const startIndex = after
      ? filtered.findIndex((article) =>
          article.publishedAt.localeCompare(after!.at) < 0 ||
          (article.publishedAt === after!.at && article.id.localeCompare(after!.id) < 0))
      : 0;
    const slice = startIndex === -1 ? [] : filtered.slice(startIndex, startIndex + options.limit);
    const hasMore = startIndex !== -1 && startIndex + options.limit < filtered.length;
    const last = slice.at(-1);
    return {
      articles: slice,
      nextCursor: hasMore && last
        ? encodeCursor({ id: last.id, at: last.publishedAt, view: options.view, savedOnly: options.savedOnly })
        : null,
    };
  };

  const getArticle = async (rawArticleId: string) => {
    const articleId = validId(rawArticleId, "articleId");
    const state = await deps.repository.read();
    const item = state.processing.items.find((candidate) => candidate.id === articleId);
    if (!item) throw new NewsError("NOT_FOUND", `Unknown news article: ${articleId}`);
    const recommendations = recommendationMap(state.processing.runs);
    const feedbackByItem = new Map(state.processing.articleFeedback.map((fb) => [fb.itemId, fb]));
    return { article: projectArticle(item, recommendations, feedbackByItem) };
  };

  const updateArticleFeedback = async (
    rawArticleId: string,
    change: (feedback: NewsArticleFeedback) => NewsArticleFeedback,
  ): Promise<NewsArticleFeedback> => {
    ensureOpen();
    const articleId = validId(rawArticleId, "articleId");
    const outcome = await deps.repository.update((state) => {
      const item = state.processing.items.find((entry) => entry.id === articleId);
      if (!item) {
        throw new NewsError("NOT_FOUND", `Unknown news article: ${articleId}`);
      }
      const existing = state.processing.articleFeedback.find((fb) => fb.itemId === articleId);
      const nextFeedback = change(structuredClone(existing ?? emptyFeedbackFor(articleId)));
      const changed = existing
        ? existing.reaction !== nextFeedback.reaction ||
          existing.saved !== nextFeedback.saved ||
          JSON.stringify(existing.comments) !== JSON.stringify(nextFeedback.comments)
        : nextFeedback.reaction !== null || nextFeedback.saved || nextFeedback.comments.length > 0;
      if (!changed) {
        return { result: { item, nextFeedback, changed: false } };
      }
      const remaining = state.processing.articleFeedback.filter((fb) => fb.itemId !== articleId);
      const keep =
        nextFeedback.reaction !== null ||
        nextFeedback.saved ||
        nextFeedback.comments.length > 0;
      const articleFeedback = keep ? [...remaining, nextFeedback] : remaining;
      return {
        state: {
          ...state,
          processing: { ...state.processing, articleFeedback },
        },
        result: { item, nextFeedback, changed: true },
      };
    });
    if (outcome.changed && deps.onFeedbackChanged) {
      await deps.onFeedbackChanged(toNewsHabitSignal(outcome.item, outcome.nextFeedback));
    }
    return outcome.nextFeedback;
  };

  const setArticleReaction = (articleId: string, reaction: NewsArticleReaction) =>
    updateArticleFeedback(articleId, (fb) => ({ ...fb, reaction }));

  const setArticleSaved = (articleId: string, saved: boolean) =>
    updateArticleFeedback(articleId, (fb) => ({ ...fb, saved }));

  const addArticleComment = (articleId: string, rawText: string) => {
    const text = normalizeText(rawText, "comment text", 4000);
    if (!text) throw new NewsError("INVALID_INPUT", "Comment text must be non-blank");
    const now = new Date().toISOString();
    return updateArticleFeedback(articleId, (fb) => ({
      ...fb,
      comments: [
        ...fb.comments,
        { id: `comment_${randomUUID()}`, text, createdAt: now, updatedAt: now },
      ],
    }));
  };

  const deleteArticleComment = (rawArticleId: string, rawCommentId: string) => {
    const commentId = validId(rawCommentId, "commentId");
    return updateArticleFeedback(rawArticleId, (fb) => {
      const index = fb.comments.findIndex((comment) => comment.id === commentId);
      if (index === -1) throw new NewsError("NOT_FOUND", `Unknown news comment: ${commentId}`);
      fb.comments.splice(index, 1);
      return fb;
    });
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

  const getPreferences = async () => {
    const [{ instructions, includes }, habitCtx] = await Promise.all([
      readInstructionsWithIncludes(),
      habitsPort.getPromptContext("news"),
    ]);
    return {
      instructions,
      includes,
      habits: habitCtx.habits,
      unconsolidatedFeedbackCount: habitCtx.unconsolidatedCount,
    };
  };

  const savePreferences = async (input: { instructions: string }) => {
    ensureOpen();
    if (typeof input.instructions !== "string" || !isWorkspaceText(input.instructions)) {
      throw new NewsError("INVALID_INPUT", "Preferences instructions contain invalid control characters");
    }
    if (input.instructions.length > NEWS_PREFERENCES_INSTRUCTIONS_MAX_LENGTH) {
      throw new NewsError(
        "INVALID_INPUT",
        `Preferences instructions must be at most ${NEWS_PREFERENCES_INSTRUCTIONS_MAX_LENGTH} characters`,
      );
    }
    await deps.instructions.write(input.instructions);
    notifyChanged("preferences");
    return getPreferences();
  };

  const listRuns = async (options: {
    status?: string;
    limit?: number;
    cursor?: string;
  }) => {
    const allowedStatuses = new Set(["running", "completed", "failed", "cancelled"]);
    if (options.status !== undefined && !allowedStatuses.has(options.status)) {
      throw new NewsError("INVALID_INPUT", `Invalid run status filter: ${options.status}`);
    }
    const statusFilter = options.status as NewsScreeningRunStatus | undefined;
    const state = await deps.repository.read();
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    let after: RunCursor | undefined;
    if (options.cursor !== undefined) {
      const decoded = decodeCursor<RunCursor>(options.cursor);
      if (!decoded || typeof decoded.id !== "string" || typeof decoded.at !== "string" || decoded.status !== statusFilter) {
        throw new NewsError("INVALID_INPUT", "Invalid runs cursor");
      }
      after = decoded;
    }
    const ordered = [...state.processing.runs]
      .filter((run) => !statusFilter || run.status === statusFilter)
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
      nextCursor: hasMore && last
        ? encodeCursor({ id: last.id, at: last.startedAt, ...(statusFilter ? { status: statusFilter } : {}) })
        : null,
    };
  };

  const getRun = async (rawRunId: string) => {
    const runId = validId(rawRunId, "runId");
    const state = await deps.repository.read();
    const run = state.processing.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new NewsError("NOT_FOUND", `Unknown news screening run: ${runId}`);
    const itemById = new Map(state.processing.items.map((item) => [item.id, item]));
    const items = run.itemIds.map((id) => itemById.get(id)).filter((item): item is NewsArticleItem => Boolean(item));
    return { run, items };
  };

  const pruneCompletedArticles = (
    items: readonly NewsArticleItem[],
    runs: readonly NewsScreeningRun[],
    articleFeedback: readonly NewsArticleFeedback[],
  ) => {
    const feedbackIds = new Set(articleFeedback.map((fb) => fb.itemId));
    const prunable = items
      .filter((item) => item.status === "processed" && !feedbackIds.has(item.id))
      .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id));
    if (prunable.length <= maxRetainedArticles) {
      return { items: [...items], runs: [...runs] };
    }
    const dropIds = new Set(prunable.slice(0, prunable.length - maxRetainedArticles).map((item) => item.id));
    const remainingItems = items.filter((item) => !dropIds.has(item.id));
    const remainingRuns: NewsScreeningRun[] = [];
    for (const run of runs) {
      const nextItemIds = run.itemIds.filter((id) => !dropIds.has(id));
      if (!nextItemIds.length) continue;
      remainingRuns.push({
        ...run,
        itemIds: nextItemIds,
        ...(run.decisions ? { decisions: run.decisions.filter((d) => !dropIds.has(d.itemId)) } : {}),
      });
    }
    return { items: remainingItems, runs: remainingRuns };
  };

  const executeBatch = async (): Promise<void> => {
    const claimed = await deps.repository.update<{
      runId: string;
      items: NewsArticleItem[];
    } | null>((state) => {
      const pending = state.processing.items.filter((item) => item.status === "pending");
      if (!pending.length) return { result: null };
      const selected: NewsArticleItem[] = [];
      let chars = 0;
      for (const item of pending) {
        if (selected.length >= NEWS_BATCH_ITEMS) break;
        if (selected.length > 0 && chars + item.content.length > NEWS_BATCH_CHARS) break;
        selected.push(item);
        chars += item.content.length;
      }
      const now = new Date().toISOString();
      const runId = `newsrun_${randomUUID()}`;
      const selectedIds = new Set(selected.map((item) => item.id));
      const run: NewsScreeningRun = {
        id: runId,
        status: "running",
        createdAt: now,
        startedAt: now,
        itemIds: selected.map((item) => item.id),
      };
      return {
        state: {
          ...state,
          processing: {
            ...state.processing,
            items: state.processing.items.map((item) =>
              selectedIds.has(item.id) ? { ...item, status: "processing" as const, runId } : item),
            runs: [...state.processing.runs, run],
          },
        },
        result: {
          runId,
          items: selected,
        },
      };
    });

    if (!claimed) return;

    const finishWork = deps.observeWork?.("main", "information-news", "正在筛选推荐新闻");
    const controller = new AbortController();
    activeController = controller;
    let modelOutcome: NewsScreeningModelOutcome;
    try {
      const [instructions, habitCtx] = await Promise.all([
        (deps.instructions.readResolved ?? deps.instructions.read)(),
        habitsPort.getPromptContext("news"),
      ]);
      modelOutcome = await deps.runModel({
        runId: claimed.runId,
        instructions,
        habits: habitCtx.habits,
        feedbackExamples: signalsToNewsExamples(habitCtx.unconsolidatedSignals),
        items: claimed.items.map((item) => ({
          id: item.id,
          source: item.source,
          externalId: item.externalId,
          ...(item.title !== undefined ? { title: item.title } : {}),
          content: item.content,
          receivedAt: item.receivedAt,
          acceptedAt: item.acceptedAt,
          ...(item.metadata ? { metadata: item.metadata } : {}),
        })),
      }, controller.signal);
    } catch (error) {
      modelOutcome = { ok: false, error: sanitizeError(error) };
    } finally {
      if (activeController === controller) activeController = undefined;
    }

    const finishedAt = new Date().toISOString();
    const claimedIdSet = new Set(claimed.items.map((item) => item.id));
    if (modelOutcome.ok) {
      let parsed: NewsScreeningResult | undefined;
      let parseError: string | undefined;
      try {
        parsed = parseNewsScreeningResult(modelOutcome.result, claimed.items.map((item) => item.id));
      } catch (error) {
        parseError = sanitizeError(error);
      }
      if (parsed) {
        const hasRecommendations = parsed.decisions.some((d) => d.decision === "notify");
        await deps.repository.update((state) => {
          const updatedItems = state.processing.items.map((item) =>
            claimedIdSet.has(item.id) ? { ...item, status: "processed" as const } : item);
          const updatedRuns = state.processing.runs.map((run) =>
            run.id === claimed.runId
              ? {
                  ...run,
                  status: "completed" as const,
                  finishedAt,
                  model: { status: "succeeded" as const },
                  decisions: parsed!.decisions,
                }
              : run);
          const pruned = pruneCompletedArticles(
            updatedItems,
            updatedRuns,
            state.processing.articleFeedback,
          );
          return {
            state: {
              ...state,
              processing: {
                ...state.processing,
                items: pruned.items,
                runs: pruned.runs,
              },
            },
            result: undefined,
          };
        });
        notifyChanged("items");
        notifyChanged("runs");
        finishWork?.("succeeded", hasRecommendations);
        return;
      }
      modelOutcome = { ok: false, error: parseError ?? "Invalid news screening result" };
    }

    const errorMessage = sanitizeError(modelOutcome.error);
    await deps.repository.update((state) => ({
      state: {
        ...state,
        processing: {
          ...state.processing,
          items: state.processing.items.map((item) =>
            claimedIdSet.has(item.id) ? { ...item, status: "failed" as const } : item),
          runs: state.processing.runs.map((run) =>
            run.id === claimed.runId
              ? {
                  ...run,
                  status: "failed" as const,
                  finishedAt,
                  model: { status: "failed" as const, error: errorMessage },
                }
              : run),
        },
      },
      result: undefined,
    }));
    notifyChanged("items");
    notifyChanged("runs");
    finishWork?.("failed");
  };

  const nextDue = async (): Promise<boolean> => {
    if (closed || isPaused() || activePromise) return false;
    if (deps.repository.hasPendingArticle) {
      return deps.repository.hasPendingArticle();
    }
    const state = await deps.repository.read();
    return state.processing.items.some((item) => item.status === "pending");
  };

  const runDue = async (): Promise<void> => {
    if (closed || isPaused() || activePromise) return;
    const run = executeBatch().finally(() => {
      if (activePromise === run) activePromise = undefined;
    });
    activePromise = run;
    await run;
  };

  const pause = () => {
    pauseDepth++;
    if (pauseDepth === 1) activeController?.abort();
    const stopped = Promise.resolve(activePromise).then(() => undefined);
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
    await activePromise;
  };

  return {
    getCounts,
    ingest,
    retryFailed,
    listArticles,
    getArticle,
    setArticleReaction,
    setArticleSaved,
    addArticleComment,
    deleteArticleComment,
    getPreferences,
    savePreferences,
    listRuns,
    getRun,
    nextDue,
    runDue,
    pause,
    close,
  };
};

export type NewsScreeningService = ReturnType<typeof createNewsScreeningService>;

export type NewsScreeningScheduler = {
  start: () => void;
  close: () => Promise<void>;
};

export const createNewsScreeningScheduler = (
  screening: Pick<NewsScreeningService, "nextDue" | "runDue">,
  options?: { isEnabled?: () => Promise<boolean> | boolean },
): NewsScreeningScheduler => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let scan: Promise<void> = Promise.resolve();
  let scanning = false;

  const tick = async () => {
    if (options?.isEnabled && !(await options.isEnabled())) return;
    if (await screening.nextDue()) await screening.runDue();
  };

  return {
    start: () => {
      if (closed || timer) return;
      timer = setInterval(() => {
        if (closed || scanning) return;
        scanning = true;
        scan = tick()
          .catch(() => undefined)
          .finally(() => {
            scanning = false;
          });
      }, 500);
      timer.unref();
    },
    close: async () => {
      if (closing) return closing;
      closed = true;
      if (timer) clearInterval(timer);
      closing = scan.catch(() => undefined);
      return closing;
    },
  };
};
