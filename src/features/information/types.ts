import type { WorkspaceIncludeDiagnostic } from "../../shared/workspace-includes.js";
import type { HabitItem, HabitOperation } from "../habits/types.js";

export type InformationSettings = {
  enabled: boolean;
  batchWindowSeconds: number;
};

export type InformationFeedbackExample = {
  runId: string;
  notificationId: string;
  text: string;
  reaction: "like" | "dislike" | null;
  saved: boolean;
  comments: string[];
  commentsTruncated: boolean;
  items: Array<{
    id: string;
    source: string;
    title?: string;
    content: string;
    contentTruncated: boolean;
  }>;
};

export type InformationPreferencesView = {
  instructions: string;
  includes: WorkspaceIncludeDiagnostic[];
  habits: HabitItem[];
  unconsolidatedFeedbackCount: number;
};

export type InformationInputItem = {
  source: string;
  externalId: string;
  title?: string;
  content: string;
  receivedAt?: string;
};

export type InformationQueue = "realtime" | "archive";
export type InformationItemStatus = "pending" | "processing" | "processed" | "failed";

export type InformationDecisionType = "silent" | "notify";

export type InformationItem = {
  id: string;
  queue: InformationQueue;
  source: string;
  externalId: string;
  title?: string;
  content: string;
  receivedAt: string;
  acceptedAt: string;
  status: InformationItemStatus;
  runId?: string;
  decision?: InformationDecisionType;
  reason?: string;
};

export type InformationDecision = {
  itemId: string;
  decision: InformationDecisionType;
  reason: string;
};

export type InformationPublicationReceipt = {
  notificationId: string;
  piSessionId: string;
  messageId: string;
};

export type InformationPublication = {
  notificationId: string;
  text: string;
  itemIds: string[];
  status: "pending" | "published" | "failed";
  receipt?: InformationPublicationReceipt;
  error?: string;
};

export type InformationRunStatus = "running" | "completed" | "failed" | "cancelled";
export type InformationRunKind = "realtime" | "archive";

export type InformationRun = {
  id: string;
  kind: InformationRunKind;
  status: InformationRunStatus;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  itemIds: string[];
  model?: {
    status: "succeeded" | "failed";
    error?: string;
  };
  decisions?: InformationDecision[];
  publications: InformationPublication[];
};

export type InformationNotificationDraft = {
  itemIds: string[];
  text: string;
};

export type InformationModelResult = {
  decisions: InformationDecision[];
  notifications: InformationNotificationDraft[];
  habitOperations?: HabitOperation[];
};

export type InformationModelInput = {
  runId: string;
  sessionId: string;
  kind: InformationRunKind;
  instructions: string;
  habits: HabitItem[];
  feedbackExamples: InformationFeedbackExample[];
  items: Array<{
    id: string;
    source: string;
    externalId: string;
    title?: string;
    content: string;
    receivedAt: string;
    acceptedAt: string;
  }>;
};

export type InformationModelError = "MODEL_REQUEST_FAILED" | "MODEL_CONTENT_REJECTED" | "INVALID_MODEL_RESULT" | "CANCELLED";

export type InformationModelOutcome =
  | { ok: true; result: InformationModelResult }
  | { ok: false; error: InformationModelError };

export type InformationArchiveCandidate = {
  itemId: string;
  source: string;
  title?: string;
  contentExcerpt: string;
  receivedAt: string;
  reason: string;
};

export type InformationBriefingInput = {
  runId: string;
  sessionId: string;
  instructions: string;
  habits: HabitItem[];
  feedbackExamples: InformationFeedbackExample[];
  totalScanned: number;
  silentCount: number;
  batchCount: number;
  /** 本归档波次中被上游内容安全审核拒绝而跳过的条目数（供简报自然告知用户）。 */
  skippedCount: number;
  candidates: InformationArchiveCandidate[];
};

export type InformationBriefingOutcome =
  | { ok: true; text: string; itemIds: string[] }
  | { ok: false; error: InformationModelError };

export type InformationArchiveStats = {
  running: boolean;
  pendingCount: number;
  processedCount: number;
  failedCount: number;
};

export type InformationStatus = {
  enabled: boolean;
  batchWindowSeconds: number;
  running: boolean;
  pendingCount: number;
  failedCount: number;
  archive: InformationArchiveStats;
  lastRunAt: string | null;
  lastError: string | null;
};

export type InformationArchiveRunResult = {
  status: "started" | "completed" | "partial";
  runsCount: number;
  processedCount: number;
  failedCount: number;
  remainingPendingCount: number;
  briefingPublished: boolean;
};

export type InformationStatusSummary = {
  enabled: boolean;
  batchWindowSeconds: number;
  hasRunningRow: boolean;
  pendingCount: number;
  failedCount: number;
  archivePendingCount: number;
  archiveProcessedCount: number;
  archiveFailedCount: number;
  lastRunAt: string | null;
  lastError: string | null;
};

export type InformationRepository = {
  getSettings: () => Promise<InformationSettings>;
  saveSettings: (settings: InformationSettings) => Promise<InformationSettings>;
  ingestItems: (
    queue: InformationQueue,
    inputs: readonly InformationInputItem[],
    now: string,
  ) => Promise<{ accepted: InformationItem[]; responseItems: InformationItem[]; skippedCount: number; autoEnabled?: boolean }>;
  listItems: (options: {
    queue?: InformationQueue;
    status?: InformationItemStatus;
    limit: number;
    after?: { at: string; id: string };
  }) => Promise<{ items: InformationItem[]; hasMore: boolean }>;
  getItem: (itemId: string) => Promise<{ item: InformationItem; runs: InformationRun[] } | undefined>;
  listRuns: (options: {
    kind?: InformationRunKind;
    status?: InformationRunStatus;
    limit: number;
    after?: { at: string; id: string };
  }) => Promise<{ runs: InformationRun[]; hasMore: boolean }>;
  getRun: (runId: string) => Promise<{ run: InformationRun; items: InformationItem[] } | undefined>;
  getStatusSummary: () => Promise<InformationStatusSummary>;
  requeueFailed: (queue: InformationQueue) => Promise<number>;
  claimBatch: (
    queue: InformationQueue,
    options: { forceRealtime: boolean; maxItems: number; maxChars: number; now: string },
  ) => Promise<{ run: InformationRun; items: InformationItem[] } | null>;
  /** 二分隔离专用：按精确条目 ID 认领仍处于 pending 的子切片，生成新的 running run。 */
  claimItems: (
    queue: InformationQueue,
    itemIds: readonly string[],
    now: string,
  ) => Promise<{ run: InformationRun; items: InformationItem[] } | null>;
  revertClaimedRun: (runId: string, itemIds: readonly string[], finishedAt: string) => Promise<InformationRun>;
  markRunFailed: (
    runId: string,
    itemIds: readonly string[],
    errorMessage: string,
    finishedAt: string,
  ) => Promise<InformationRun>;
  /** 多条目批次被上游内容审核拒绝时：标记该 run 失败但把条目回退为 pending，供二分隔离继续认领。 */
  markRunSplit: (
    runId: string,
    itemIds: readonly string[],
    errorMessage: string,
    finishedAt: string,
  ) => Promise<InformationRun>;
  completeModelRound: (input: {
    runId: string;
    itemIds: readonly string[];
    decisions: readonly InformationDecision[];
    publications: readonly InformationPublication[];
    finishedAt: string;
  }) => Promise<InformationRun>;
  updatePublication: (
    runId: string,
    notificationId: string,
    update: { status: "published" | "failed"; receipt?: InformationPublicationReceipt; error?: string },
  ) => Promise<void>;
  failPendingPublications: (runId: string, reason: string) => Promise<void>;
  finalizeDelivery: (
    runId: string,
    finishedAt: string,
    interruptReason: string,
  ) => Promise<InformationRun>;
  setRunPublications: (runId: string, publications: readonly InformationPublication[]) => Promise<void>;
  getNotificationContext: (notificationId: string) => Promise<{
    runId: string;
    publication: InformationPublication;
    items: InformationItem[];
  } | undefined>;
  getArchiveBriefingWave: () => Promise<{
    itemsById: Map<string, InformationItem>;
    waveRuns: InformationRun[];
    /** 本归档波次中被上游内容安全审核拒绝的条目数；存在非审核类失败时整个波次返回 null。 */
    skippedCount: number;
  } | null>;
  pruneHistory: (limits?: {
    maxProcessedRealtimeItems?: number;
    maxProcessedArchiveItems?: number;
  }) => Promise<{ deletedItems: number; deletedRuns: number }>;
  validateAll: () => Promise<void>;
  nextRealtimeDue: () => Promise<boolean>;
  reconcileOnStart: () => Promise<void>;
};
