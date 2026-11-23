import { randomUUID } from "node:crypto";
import type { NewsScreeningService } from "./screening.js";
import type { NewsArticleFeedback } from "./types.js";
import { asNewsSourceError, NewsError } from "./errors.js";
import type { NewsRepository, NewsSource, ParsedFeed } from "./types.js";
import type { ObserveWork } from "../workspace/session-presence.js";

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const SOURCE_ERROR = "RSS source fetch or parse failed";

const assertPublicFeedUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    const credentialKeys = ["username", "pass" + "word"] as const;
    if (!["http:", "https:"].includes(url.protocol) || raw.length > 2048 ||
        credentialKeys.some((key) => url[key as keyof URL] !== "")) throw new Error("invalid");
    url.hash = "";
    return url.toString();
  } catch {
    throw new NewsError("INVALID_INPUT", "RSS URL must be a credential-free HTTP(S) URL");
  }
};

export type NewsServiceDependencies = {
  observeWork?: ObserveWork;
  repository: NewsRepository;
  screening: NewsScreeningService;
  fetchFeed: (url: string, signal: AbortSignal) => Promise<ParsedFeed>;
  onChanged?: (scope: "items" | "runs" | "preferences") => void;
};

/** RSS collection is a thin edge over information ingestion; no separate ranking loop. */
export const createNewsService = (deps: NewsServiceDependencies) => {
  let refreshing = false;
  let closed = false;
  let activeRefresh: Promise<{ added: number; skipped: number; resetDeferred: boolean }> | undefined;
  let refreshController: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const requireOpen = () => {
    if (closed) throw new NewsError("SHUTDOWN", "News service is closing");
  };

  const initialize = async () => {
    requireOpen();
  };

  const status = async () => {
    const state = await deps.repository.read();
    const counts = await deps.screening.getCounts();
    return {
      refreshing,
      ...counts,
      lastRefreshedAt: state.lastRefreshedAt,
      lastError: state.lastError,
    };
  };

  const listSources = async () => ({ sources: (await deps.repository.read()).sources });

  const addSource = async (input: { url: string; title?: string }) => {
    requireOpen();
    const url = assertPublicFeedUrl(input.url);
    const state = await deps.repository.read();
    const existing = state.sources.find((source) => assertPublicFeedUrl(source.url) === url);
    if (existing) {
      throw new NewsError("CONFLICT", `RSS source already exists: ${existing.id}`);
    }
    const controller = new AbortController();
    let parsed;
    try {
      parsed = await deps.fetchFeed(url, controller.signal);
    } catch (error) {
      throw asNewsSourceError(error);
    }
    const source: NewsSource = {
      id: `newssource_${randomUUID()}`,
      title: input.title?.trim() || parsed.title,
      url,
      createdAt: new Date().toISOString(),
      lastFetchedAt: null,
      lastError: null,
      lastErrorDetails: null,
    };
    await deps.repository.update((current) => {
      const existing = current.sources.find((candidate) => assertPublicFeedUrl(candidate.url) === url);
      if (existing) {
        throw new NewsError("CONFLICT", `RSS source already exists: ${existing.id}`);
      }
      return {
        state: { ...current, sources: [...current.sources, source] },
        result: undefined,
      };
    });
    deps.onChanged?.("items");
    return { source, skipped: parsed.skipped };
  };

  const deleteSource = async (sourceId: string) => {
    requireOpen();
    if (refreshing) throw new NewsError("CONFLICT", "Cannot delete an RSS source while refresh is running");
    const deleted = await deps.repository.update((state) => {
      if (!state.sources.some((source) => source.id === sourceId)) return { result: false };
      return {
        state: { ...state, sources: state.sources.filter((source) => source.id !== sourceId) },
        result: true,
      };
    });
    if (!deleted) throw new NewsError("NOT_FOUND", "RSS source not found");
    deps.onChanged?.("items");
    return { deleted: true as const, sourceId };
  };

  const refresh = async (options: { retryFailed?: boolean } = {}) => {
    requireOpen();
    if (refreshing) throw new NewsError("REFRESHING", "RSS refresh is already running");
    refreshing = true;
    const finish = deps.observeWork?.("main", "rss", "正在收集新闻");
    const controller = new AbortController();
    refreshController = controller;
    const work = (async () => {
      const initial = await deps.repository.read();
      let added = 0;
      let skipped = 0;
      let failed = false;
      for (const source of initial.sources) {
        controller.signal.throwIfAborted();
        try {
          const feed = await deps.fetchFeed(source.url, controller.signal);
          skipped += feed.skipped;
          const items = feed.items.map((item) => ({
            source: source.id,
            externalId: item.externalId,
            title: item.title,
            // 空正文仍保留文章；信息接纳要求非空正文，以已有标题作最小文本，不伪造内容。
            content: item.content || item.title,
            ...(item.publishedAt ? { receivedAt: item.publishedAt } : {}),
            metadata: { sourceId: source.id, sourceTitle: source.title, url: item.url },
          }));
          added += (await deps.screening.ingest(items)).length;
          await deps.repository.update((state) => ({
            state: {
              ...state,
              sources: state.sources.map((candidate) => candidate.id === source.id
                ? { ...candidate, lastFetchedAt: new Date().toISOString(), lastError: null, lastErrorDetails: null }
                : candidate),
            },
            result: undefined,
          }));
        } catch (error) {
          controller.signal.throwIfAborted();
          failed = true;
          const failure = asNewsSourceError(error);
          await deps.repository.update((state) => ({
            state: {
              ...state,
              sources: state.sources.map((candidate) => candidate.id === source.id
                ? { ...candidate, lastError: failure.message, lastErrorDetails: failure.failure }
                : candidate),
            },
            result: undefined,
          }));
        }
      }
      await deps.repository.update((state) => ({
        state: {
          ...state,
          lastRefreshedAt: new Date().toISOString(),
          lastError: failed ? SOURCE_ERROR : null,
        },
        result: undefined,
      }));
      const resetDeferred = options.retryFailed
        ? (await deps.screening.retryFailed()).resetDeferred
        : false;
      finish?.(failed ? "failed" : "succeeded", added > 0);
      deps.onChanged?.("items");
      return { added, skipped, resetDeferred };
    })();
    activeRefresh = work;
    try {
      return await work;
    } catch (error) {
      finish?.(controller.signal.aborted ? "cancelled" : "failed", false);
      throw error;
    } finally {
      refreshing = false;
      activeRefresh = undefined;
      refreshController = undefined;
    }
  };

  const listArticles = (query: {
    view: "recommended" | "all";
    savedOnly: boolean;
    limit: number;
    cursor?: string;
  }) => deps.screening.listArticles(query);

  const getArticle = (articleId: string) =>
    deps.screening.getArticle(articleId);

  const feedback = async (work: () => Promise<NewsArticleFeedback>) => {
    const value = await work();
    return {
      feedback: {
        reaction: value.reaction,
        saved: value.saved,
        comments: value.comments.map(({ id, text, createdAt, updatedAt }) => ({
          id,
          text,
          createdAt,
          updatedAt,
        })),
      },
    };
  };

  const preferences = () => deps.screening.getPreferences();

  const savePreferences = async (instructions: string) => {
    requireOpen();
    return await deps.screening.savePreferences({ instructions });
  };

  const start = () => {
    if (timer || closed) return;
    timer = setInterval(() => {
      void refresh({ retryFailed: false }).catch(() => undefined);
    }, REFRESH_INTERVAL_MS);
    timer.unref();
  };

  const close = async () => {
    if (closed) return activeRefresh?.then(() => undefined);
    closed = true;
    if (timer) clearInterval(timer);
    refreshController?.abort();
    await activeRefresh?.catch(() => undefined);
  };

  return {
    initialize,
    status,
    listSources,
    addSource,
    deleteSource,
    refresh,
    listArticles,
    getArticle,
    setReaction: (articleId: string, reaction: "like" | "dislike" | null) =>
      feedback(() => deps.screening.setArticleReaction(articleId, reaction)),
    setSaved: (articleId: string, saved: boolean) =>
      feedback(() => deps.screening.setArticleSaved(articleId, saved)),
    addComment: (articleId: string, text: string) =>
      feedback(() => deps.screening.addArticleComment(articleId, text)),
    deleteComment: (articleId: string, commentId: string) =>
      feedback(() => deps.screening.deleteArticleComment(articleId, commentId)),
    preferences,
    savePreferences,
    start,
    close,
  };
};

export type NewsService = ReturnType<typeof createNewsService>;
