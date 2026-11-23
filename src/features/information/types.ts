export type InformationSettings = {
  enabled: boolean;
  batchWindowSeconds: number;
};

export type InformationPreferences = {
  learnedNotes: string;
};

export type InformationFeedbackExample = {
  runId: string;
  notificationId: string;
  text: string;
  reaction: "like" | "dislike" | null;
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
  learnedNotes: string;
  feedbackExamples: InformationFeedbackExample[];
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
};

export type InformationDecisionType = "silent" | "notify";

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

export type InformationState = {
  schemaVersion: 2;
  settings: InformationSettings;
  preferences: InformationPreferences;
  items: InformationItem[];
  runs: InformationRun[];
};

export const defaultInformationState = (): InformationState => ({
  schemaVersion: 2,
  settings: { enabled: false, batchWindowSeconds: 15 },
  preferences: { learnedNotes: "" },
  items: [],
  runs: [],
});

export type InformationNotificationDraft = {
  itemIds: string[];
  text: string;
};

export type InformationModelResult = {
  decisions: InformationDecision[];
  notifications: InformationNotificationDraft[];
  learnedNotes?: string;
};

export type InformationModelInput = {
  runId: string;
  sessionId: string;
  kind: InformationRunKind;
  instructions: string;
  learnedNotes: string;
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

export type InformationModelError = "MODEL_REQUEST_FAILED" | "INVALID_MODEL_RESULT" | "CANCELLED";

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
  learnedNotes: string;
  feedbackExamples: InformationFeedbackExample[];
  totalScanned: number;
  silentCount: number;
  batchCount: number;
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

export type InformationRepository = {
  read: () => Promise<InformationState>;
  update: <T>(
    change: (state: InformationState) => { state?: InformationState; result: T } | Promise<{ state?: InformationState; result: T }>,
  ) => Promise<T>;
  validateAll: () => Promise<void>;
  nextRealtimeDue: () => Promise<boolean>;
  reconcileOnStart: () => Promise<void>;
};
