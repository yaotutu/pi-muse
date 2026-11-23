import type {
  UserFeedbackComment,
  UserFeedbackSnapshot,
  UserReaction,
} from "../../shared/feedback.js";
import type { NewsSourceFailure } from "./errors.js";

export type NewsSource = {
  id: string;
  title: string;
  url: string;
  createdAt: string;
  lastFetchedAt: string | null;
  lastError: string | null;
  lastErrorDetails?: NewsSourceFailure | null;
};

export type NewsItemStatus = "pending" | "processing" | "processed" | "failed";

export type NewsItemMetadata = {
  sourceId: string;
  sourceTitle: string;
  url?: string | null;
};

export type NewsArticleItem = {
  id: string;
  source: string;
  externalId: string;
  title?: string;
  content: string;
  receivedAt: string;
  acceptedAt: string;
  status: NewsItemStatus;
  runId?: string;
  metadata?: NewsItemMetadata;
};

export type NewsArticleReaction = UserReaction | null;

export type NewsArticleFeedbackComment = UserFeedbackComment;

export type NewsArticleFeedback = UserFeedbackSnapshot & {
  itemId: string;
};

export type NewsScreeningDecision = {
  itemId: string;
  decision: "silent" | "notify";
  reason: string;
};

export type NewsScreeningRunStatus = "running" | "completed" | "failed" | "cancelled";

export type NewsScreeningRun = {
  id: string;
  status: NewsScreeningRunStatus;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  itemIds: string[];
  model?: {
    status: "succeeded" | "failed";
    error?: string;
  };
  decisions?: NewsScreeningDecision[];
  publications: [];
};

export type NewsProcessingSettings = {
  enabled: boolean;
  batchWindowSeconds: number;
};

export type NewsPreferences = {
  learnedNotes: string;
};

export type NewsProcessingState = {
  settings: NewsProcessingSettings;
  preferences: NewsPreferences;
  articleFeedback: NewsArticleFeedback[];
  items: NewsArticleItem[];
  runs: NewsScreeningRun[];
};

export const defaultNewsProcessingState = (): NewsProcessingState => ({
  settings: { enabled: true, batchWindowSeconds: 0 },
  preferences: { learnedNotes: "" },
  articleFeedback: [],
  items: [],
  runs: [],
});

export type NewsState = {
  schemaVersion: 1;
  sources: NewsSource[];
  lastRefreshedAt: string | null;
  lastError: string | null;
  processing: NewsProcessingState;
};

export const defaultNewsState = (): NewsState => ({
  schemaVersion: 1,
  sources: [],
  lastRefreshedAt: null,
  lastError: null,
  processing: defaultNewsProcessingState(),
});

export type NewsRepository = {
  read: () => Promise<NewsState>;
  update: <T>(
    change: (state: NewsState) => { state?: NewsState; result: T } | Promise<{ state?: NewsState; result: T }>,
  ) => Promise<T>;
  validate: () => Promise<void>;
  hasPendingArticle?: () => Promise<boolean>;
  reconcileOnStart?: () => Promise<void>;
};

export type ParsedFeedItem = {
  externalId: string;
  title: string;
  url: string | null;
  content: string;
  publishedAt?: string;
};

export type ParsedFeed = {
  title: string;
  items: ParsedFeedItem[];
  skipped: number;
};
