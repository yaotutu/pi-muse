import type { UserReaction } from "../../shared/feedback.js";

export const HABIT_DOMAIN_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const HABIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const MAX_HABITS_PER_DOMAIN = 50;
export const MAX_HABIT_TEXT_LENGTH = 300;

/** 习惯自动归纳兜底周期：与 Dream 一致为 2 小时。 */
export const HABIT_CONSOLIDATION_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** 去重后未消化反馈达到该数量时后台自动触发一次归纳。 */
export const HABIT_AUTO_THRESHOLD = 5;
/** 单次送入模型的去重目标条数上限，按 seq 分批推进游标避免丢失或上下文爆炸。 */
export const HABIT_SIGNAL_BATCH_SIZE = 25;
/** 热缓冲注入日常筛选/偏好读取时的最大近期未消化条数。 */
export const HABIT_HOT_BUFFER_MAX = 20;

export type HabitSource = "consolidated" | "manual";

export type HabitItem = {
  id: string;
  domain: string;
  text: string;
  source: HabitSource;
  createdAt: string;
  updatedAt: string;
};

export type HabitOperation =
  | { op: "add"; text: string }
  | { op: "edit"; id: string; text: string }
  | { op: "delete"; id: string };

export type HabitSignalItem = {
  id: string;
  source: string;
  title?: string;
  content: string;
  contentTruncated?: boolean;
};

export type HabitSignalPayload = {
  targetId: string;
  kind: string;
  summary?: string;
  reaction: UserReaction | null;
  saved: boolean;
  comments: string[];
  commentsTruncated?: boolean;
  items?: HabitSignalItem[];
  meta?: Record<string, string>;
  updatedAt: string;
};

export type HabitSignalRecord = {
  seq: number;
  domain: string;
  targetId: string;
  payload: HabitSignalPayload;
  createdAt: string;
};

export type HabitRunStatus = "succeeded" | "failed" | "skipped" | "cancelled";

export type HabitDomainMeta = {
  domain: string;
  cursorSeq: number;
  lastRunAt: string | null;
  lastRunStatus: HabitRunStatus | null;
  lastRunProcessed: number;
  lastRunError: string | null;
};

export type HabitPendingSignal = {
  targetId: string;
  kind: string;
  summary: string;
  reaction: UserReaction | null;
  saved: boolean;
  comments: string[];
  commentsTruncated: boolean;
  updatedAt: string;
};

export type HabitDomainSummary = {
  domain: string;
  name: string;
  summary: string;
  running: boolean;
  habitsCount: number;
  unconsolidatedCount: number;
  autoThreshold: number;
  intervalMs: number;
  lastRunAt: string | null;
  lastRunStatus: HabitRunStatus | null;
  lastRunError: string | null;
};

export type HabitDomainOverview = {
  domain: string;
  name: string;
  summary: string;
  running: boolean;
  habits: HabitItem[];
  unconsolidatedCount: number;
  pendingSignals: HabitPendingSignal[];
  autoThreshold: number;
  intervalMs: number;
  cursorSeq: number;
  lastRunAt: string | null;
  lastRunStatus: HabitRunStatus | null;
  lastRunProcessed: number;
  lastRunError: string | null;
};

export type HabitPromptContext = {
  habits: HabitItem[];
  unconsolidatedSignals: HabitSignalPayload[];
  unconsolidatedCount: number;
};

export type HabitConsolidateModelInput = {
  domain: string;
  domainName: string;
  domainSummary: string;
  instructions: string;
  existingHabits: HabitItem[];
  signals: HabitSignalPayload[];
};

export type HabitConsolidateModelError =
  | "MODEL_REQUEST_FAILED"
  | "MODEL_CONTENT_REJECTED"
  | "INVALID_MODEL_RESULT"
  | "CANCELLED";

export type HabitConsolidateModelOutcome =
  | { ok: true; operations: HabitOperation[] }
  | { ok: false; error: HabitConsolidateModelError };

export type HabitDomainDefinition = {
  id: string;
  name: string;
  summary: string;
  readInstructions?: () => Promise<string>;
};

export type HabitRepository = {
  validateAll: () => Promise<void>;
  listHabits: (domain: string) => Promise<HabitItem[]>;
  getDomainMeta: (domain: string) => Promise<HabitDomainMeta>;
  addHabit: (domain: string, text: string, source: HabitSource) => Promise<HabitItem>;
  updateHabit: (domain: string, habitId: string, text: string) => Promise<HabitItem>;
  deleteHabit: (domain: string, habitId: string) => Promise<{ deleted: true; id: string }>;
  appendSignal: (domain: string, targetId: string, payload: HabitSignalPayload) => Promise<HabitSignalRecord>;
  listUnconsolidatedSignals: (domain: string) => Promise<HabitSignalRecord[]>;
  applyOperations: (input: {
    domain: string;
    operations: readonly HabitOperation[];
    source: HabitSource;
    expectedUpdatedAt?: ReadonlyMap<string, string>;
  }) => Promise<HabitItem[]>;
  commitConsolidationBatch: (input: {
    domain: string;
    operations: readonly HabitOperation[];
    source: HabitSource;
    advanceCursorToSeq: number;
    processedCount: number;
    status: "succeeded" | "skipped";
    at: string;
    expectedUpdatedAt?: ReadonlyMap<string, string>;
  }) => Promise<HabitItem[]>;
  recordRunFailure: (input: {
    domain: string;
    status: "failed" | "cancelled";
    error: string;
    at: string;
  }) => Promise<void>;
};
