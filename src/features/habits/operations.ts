import { isWorkspaceText } from "../../shared/workspace-text.js";
import { HabitError } from "./errors.js";
import {
  HABIT_ID_PATTERN,
  MAX_HABITS_PER_SUBAGENT,
  MAX_HABIT_TEXT_LENGTH,
  type HabitItem,
  type HabitOperation,
  type HabitSignalPayload,
  type HabitSignalRecord,
} from "./types.js";

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeHabitText = (raw: unknown): string => {
  if (typeof raw !== "string" || !isWorkspaceText(raw)) {
    throw new HabitError("INVALID_INPUT", "Habit text must be valid UTF-8 text without NUL characters");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new HabitError("INVALID_INPUT", "Habit text cannot be empty");
  }
  if (trimmed.length > MAX_HABIT_TEXT_LENGTH) {
    throw new HabitError(
      "INVALID_INPUT",
      `Habit text must be at most ${MAX_HABIT_TEXT_LENGTH} characters`,
    );
  }
  return trimmed;
};

export const isActiveSignalPayload = (payload: HabitSignalPayload): boolean =>
  payload.reaction !== null || payload.saved || payload.comments.length > 0;

/**
 * 校验结构化习惯变更操作列表：
 * - add: 仅允许 { op: "add", text }
 * - edit: 仅允许 { op: "edit", id, text }，目标 id 必须存在于 existingIds（若传入）且同批不可重复编辑同一 id
 * - delete: 仅允许 { op: "delete", id }，目标 id 必须存在于 existingIds（若传入）且同批不可重复操作同一 id
 */
export const parseHabitOperationsArray = (
  raw: unknown,
  options?: { existingIds?: ReadonlySet<string> },
): HabitOperation[] => {
  if (!Array.isArray(raw)) {
    throw new HabitError("INVALID_INPUT", "Habit operations must be an array");
  }
  if (raw.length > MAX_HABITS_PER_SUBAGENT) {
    throw new HabitError(
      "INVALID_INPUT",
      `At most ${MAX_HABITS_PER_SUBAGENT} habit operations are allowed per batch`,
    );
  }

  const seenTargetIds = new Set<string>();
  const parsed: HabitOperation[] = [];

  for (const entry of raw) {
    if (!isPlainRecord(entry)) {
      throw new HabitError("INVALID_INPUT", "Each habit operation must be an object");
    }
    const { op, id, text, ...extra } = entry;
    if (Object.keys(extra).length > 0) {
      throw new HabitError("INVALID_INPUT", `Unexpected field in habit operation: ${Object.keys(extra)[0]}`);
    }
    if (op === "add") {
      if (id !== undefined) {
        throw new HabitError("INVALID_INPUT", "add habit operation must not specify id");
      }
      parsed.push({ op: "add", text: normalizeHabitText(text) });
      continue;
    }
    if (op === "edit" || op === "delete") {
      if (typeof id !== "string" || !HABIT_ID_PATTERN.test(id.trim())) {
        throw new HabitError("INVALID_INPUT", "Habit operation id is missing or invalid");
      }
      const normalizedId = id.trim();
      if (options?.existingIds && !options.existingIds.has(normalizedId)) {
        throw new HabitError("INVALID_INPUT", `Habit operation references unknown id: ${normalizedId}`);
      }
      if (seenTargetIds.has(normalizedId)) {
        throw new HabitError("INVALID_INPUT", `Duplicate habit operation target id: ${normalizedId}`);
      }
      seenTargetIds.add(normalizedId);
      if (op === "edit") {
        parsed.push({ op: "edit", id: normalizedId, text: normalizeHabitText(text) });
      } else {
        if (text !== undefined) {
          throw new HabitError("INVALID_INPUT", "delete habit operation must not specify text");
        }
        parsed.push({ op: "delete", id: normalizedId });
      }
      continue;
    }
    throw new HabitError("INVALID_INPUT", `Unsupported habit operation: ${String(op)}`);
  }

  return parsed;
};

export const parseHabitConsolidationResult = (
  raw: unknown,
  existingIds: ReadonlySet<string>,
): HabitOperation[] => {
  if (!isPlainRecord(raw)) {
    throw new HabitError("INVALID_INPUT", "Invalid habit consolidation result");
  }
  const { operations, ...extra } = raw;
  if (Object.keys(extra).length > 0) {
    throw new HabitError("INVALID_INPUT", `Unexpected field in consolidation result: ${Object.keys(extra)[0]}`);
  }
  return parseHabitOperationsArray(operations, { existingIds });
};

/** 按系统提示词规范格式化已提炼习惯条文（纯数据行，绝不触发 frontmatter include 解析）。 */
export const formatHabitsForPrompt = (habits: readonly HabitItem[]): string => {
  if (!habits.length) return "(none)";
  return habits.map((habit) => `- [${habit.id}] ${habit.text}`).join("\n");
};

export type DedupedSignalEntry = {
  targetId: string;
  maxSeq: number;
  payload: HabitSignalPayload;
  createdAt: string;
};

/**
 * 按 targetId 合并同一目标的多次交互，保留最大 seq 的最新快照，
 * 并按 maxSeq 升序返回，保证按批推进 cursorSeq 时不会跳过交错的目标信号。
 */
export const dedupeLatestSignals = (
  records: readonly HabitSignalRecord[],
): DedupedSignalEntry[] => {
  const byTarget = new Map<string, DedupedSignalEntry>();
  for (const record of records) {
    const existing = byTarget.get(record.targetId);
    if (!existing || record.seq >= existing.maxSeq) {
      byTarget.set(record.targetId, {
        targetId: record.targetId,
        maxSeq: record.seq,
        payload: record.payload,
        createdAt: record.createdAt,
      });
    }
  }
  return [...byTarget.values()].sort((left, right) => left.maxSeq - right.maxSeq);
};
